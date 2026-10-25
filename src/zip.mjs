// Minimal remote/local zip reader: central directory parsing + per-entry extraction.
// Lets Sift read a 400 MB CI artifact's test-results.json (or one video) without downloading the rest.
import fs from "node:fs/promises";
import zlib from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** A byte source: { size, read(start, end) -> Buffer (inclusive range) }. */
export function httpSource(getUrl, { fetchImpl = fetch } = {}) {
  let size = null;
  let url = null;
  let urlAt = 0;
  const fresh = async () => {
    // Signed artifact URLs expire after ~1 minute; refresh when stale.
    if (!url || Date.now() - urlAt > 45_000) {
      url = await getUrl();
      urlAt = Date.now();
    }
    return url;
  };
  return {
    async size() {
      if (size != null) return size;
      const res = await fetchImpl(await fresh(), { method: "HEAD" });
      if (!res.ok) throw new Error(`HEAD ${res.status}`);
      size = Number(res.headers.get("content-length"));
      return size;
    },
    async read(start, end) {
      const res = await fetchImpl(await fresh(), { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`Range request failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async stream(start, end) {
      const res = await fetchImpl(await fresh(), { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`Range request failed (${res.status})`);
      return res.body;
    },
  };
}

export function fileSource(path) {
  let handle = null;
  let size = null;
  const open = async () => (handle ||= await fs.open(path, "r"));
  return {
    async size() {
      if (size == null) size = (await fs.stat(path)).size;
      return size;
    },
    async read(start, end) {
      const h = await open();
      const buf = Buffer.alloc(end - start + 1);
      await h.read(buf, 0, buf.length, start);
      return buf;
    },
    async stream(start, end) {
      const { createReadStream } = await import("node:fs");
      return createReadStream(path, { start, end });
    },
  };
}

export class ZipReader {
  constructor(source) {
    this.src = source;
    this.entries = null;
  }

  async list() {
    if (this.entries) return this.entries;
    const size = await this.src.size();
    const tailLen = Math.min(size, 128 * 1024);
    const tail = await this.src.read(size - tailLen, size - 1);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // zip64: locator sits right before the EOCD
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === SIG_EOCD64_LOC) {
        const eocd64Off = Number(tail.readBigUInt64LE(loc + 8));
        const rec = eocd64Off >= size - tailLen ? tail.subarray(eocd64Off - (size - tailLen)) : await this.src.read(eocd64Off, eocd64Off + 56 - 1);
        if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error("Bad zip64 record");
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOff = Number(rec.readBigUInt64LE(48));
      }
    }
    const cdStart = size - tailLen;
    const cd = cdOff >= cdStart && cdOff + cdSize <= size ? tail.subarray(cdOff - cdStart, cdOff - cdStart + cdSize) : await this.src.read(cdOff, cdOff + cdSize - 1);
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CEN) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
        let q = 0;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q);
          const len = extra.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            if (usize === 0xffffffff) {
              usize = Number(extra.readBigUInt64LE(r));
              r += 8;
            }
            if (csize === 0xffffffff) {
              csize = Number(extra.readBigUInt64LE(r));
              r += 8;
            }
            if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(r));
          }
          q += 4 + len;
        }
      }
      if (!name.endsWith("/")) entries.push({ name, method, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    void count;
    this.entries = entries;
    return entries;
  }

  async find(name) {
    const entries = await this.list();
    return entries.find((e) => e.name === name) || entries.find((e) => e.name.endsWith(`/${name}`)) || null;
  }

  /** Byte range of the compressed payload for an entry (needs the local header to skip name/extra). */
  async dataRange(entry) {
    const head = await this.src.read(entry.offset, entry.offset + 30 - 1);
    if (head.readUInt32LE(0) !== SIG_LOC) throw new Error(`Bad local header for ${entry.name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = entry.offset + 30 + nameLen + extraLen;
    return { start, end: start + entry.csize - 1 };
  }

  async readEntry(entry, { maxBytes = 256 * 1024 * 1024 } = {}) {
    if (entry.csize === 0) return Buffer.alloc(0);
    if (entry.usize > maxBytes || entry.csize > maxBytes) throw new Error(`Zip entry ${entry.name} is too large to buffer (${entry.usize} bytes)`);
    const { start, end } = await this.dataRange(entry);
    const raw = await this.src.read(start, end);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
  }

  /** Readable stream of the decompressed entry (for videos/traces served over HTTP). */
  async streamEntry(entry) {
    const { start, end } = await this.dataRange(entry);
    const body = await this.src.stream(start, end);
    const { Readable } = await import("node:stream");
    const readable = body instanceof Readable ? body : Readable.fromWeb(body);
    if (entry.method === 0) return readable;
    if (entry.method === 8) return readable.pipe(zlib.createInflateRaw());
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
  }
}

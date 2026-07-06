import { unixfs, type UnixFS } from "@helia/unixfs";
import { MemoryBlockstore } from "blockstore-core";
import { CID } from "multiformats/cid";

let _blockstore: MemoryBlockstore | null = null;
let _fs: UnixFS | null = null;

export async function getNode(): Promise<{ fs: UnixFS }> {
  if (_fs) return { fs: _fs };

  _blockstore = new MemoryBlockstore();
  _fs = unixfs({ blockstore: _blockstore } as any);

  return { fs: _fs };
}

export async function stopNode(): Promise<void> {
  _blockstore = null;
  _fs = null;
}

export async function addFile(content: string | Uint8Array): Promise<string> {
  const { fs } = await getNode();
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const cid = await fs.addBytes(bytes);
  return cid.toString();
}

export async function getFile(cidStr: string): Promise<Uint8Array> {
  const { fs } = await getNode();
  const cid = CID.parse(cidStr);

  const chunks: Uint8Array[] = [];
  for await (const chunk of fs.cat(cid)) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function getFileAsString(cidStr: string): Promise<string> {
  const bytes = await getFile(cidStr);
  return new TextDecoder().decode(bytes);
}

export async function addFileFromDisk(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(filePath);
  return addFile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export async function saveFileToDisk(cidStr: string, outPath: string): Promise<number> {
  const { writeFile } = await import("node:fs/promises");
  const bytes = await getFile(cidStr);
  await writeFile(outPath, bytes);
  return bytes.length;
}

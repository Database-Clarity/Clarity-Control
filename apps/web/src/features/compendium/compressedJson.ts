/** Static hosts may serve a .gz asset with Content-Encoding (decoded by fetch), or as bytes. */
export async function compressedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body = new Response(bytes);
  return bytes[0] === 0x1f && bytes[1] === 0x8b && body.body
    ? new Response(body.body.pipeThrough(new DecompressionStream('gzip'))).json()
    : body.json();
}

// Shared output cap for every publisher child process. Node's 1 MiB execFileSync default
// fails with ENOBUFS on the real data repo (ls-tree, log --name-only, cat-file).
export const maxBuffer = 1 << 30;

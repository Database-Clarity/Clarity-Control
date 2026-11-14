import { LocalRepository, RefRace } from './git.js';

export class TransportUnresolved extends Error {}
export interface RemoteOptions {
  repo?: string;
  fileUrl?: string;
  token?: string;
  timeout?: number;
}

/** Objects are built in a disposable bare cache; every ref read/write goes to receive-pack. */
export class RemoteRepository extends LocalRepository {
  protected override preserveModes = true;
  protected override requireCredits = true;
  private readonly remote: string;
  constructor(
    cache: string,
    private readonly options: RemoteOptions,
  ) {
    super(cache);
    this.requireCredits = !options.fileUrl;
    this.commandTimeout = options.timeout ?? 120_000;
    if (options.fileUrl) {
      const url = new URL(options.fileUrl);
      if (url.protocol !== 'file:' || url.host || url.search || url.hash || options.repo)
        throw new Error('Local file transport required');
      this.remote = url.href;
    } else {
      if (options.repo !== 'Database-Clarity/Live-Clarity-Database' || !options.token)
        throw new Error('Held GitHub target and GITHUB_TOKEN required');
      this.remote = `https://github.com/${options.repo}.git`;
    }
  }
  /** Public seam for subprocess fault injection, never exposes Git's stderr/credential-bearing errors. */
  remoteGit(args: string[]): string {
    const auth = this.options.token
      ? {
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.options.token}`).toString('base64')}`,
          GIT_CONFIG_KEY_1: 'credential.helper',
          GIT_CONFIG_VALUE_1: '',
        }
      : {};
    try {
      // The timeout is enforced inside git(), including fetch/ls-remote, and all diagnostics are sanitized.
      return this.git(args, undefined, { ...auth, GIT_TERMINAL_PROMPT: '0' });
    } catch {
      throw new TransportUnresolved('Remote Git outcome unresolved');
    }
  }
  private validate(ref: string) {
    if (
      !/^refs\/heads\/(editor-data|converter-v2-test|editor-data-bundle|publish-candidate\/[0-7][0-9A-HJKMNP-TV-Z]{25})$/.test(
        ref,
      )
    )
      throw new Error('Remote ref outside publisher scope');
  }
  override head(ref: string): string | undefined {
    this.validate(ref);
    const advertised = this.remoteGit(['ls-remote', '--refs', this.remote, ref]).trim();
    if (!advertised) {
      this.git(['update-ref', '-d', ref]);
      return undefined;
    }
    this.remoteGit(['fetch', '--no-tags', this.remote, ref]);
    const oid = this.git(['rev-parse', '--verify', 'FETCH_HEAD']).trim();
    this.git(['update-ref', ref, oid]);
    return oid;
  }
  override cas(ref: string, old: string | undefined, next: string | undefined) {
    this.validate(ref);
    for (const oid of [old, next])
      if (oid !== undefined && !/^[0-9a-f]{40}$/.test(oid)) throw new Error('Invalid object ID');
    const candidate = ref.startsWith('refs/heads/publish-candidate/');
    if (!candidate && (!next || (old && !this.ancestor(old, next))))
      throw new Error('Data/live/bundle refs must advance monotonically');
    // Check the caller's old value, including create-only zero. A lease is exact CAS, never --force.
    if (this.head(ref) !== old) throw new RefRace('Remote ref raced');
    try {
      const status = this.remoteGit([
        'push',
        '--porcelain',
        `--force-with-lease=${ref}:${old ?? ''}`,
        this.remote,
        `${next ?? ''}:${ref}`,
      ]);
      // Exit zero without a per-ref acknowledgement is still ambiguous (e.g. a truncated reply).
      const acknowledged = status.split('\n').some((line) => {
        const [flag, mapping] = line.split('\t');
        return [' ', '*', '+', '-', '='].includes(flag) && mapping?.endsWith(`:${ref}`);
      });
      if (!acknowledged) throw new TransportUnresolved('Remote Git acknowledgement missing');
    } catch (error) {
      // Only an authoritative changed head proves a race; receipt absence proves nothing.
      if (this.head(ref) !== old) throw new RefRace('Remote ref raced or push landed');
      throw error;
    }
    this.git(next ? ['update-ref', ref, next] : ['update-ref', '-d', ref]);
  }
}

export class StringReader {
  #s: string;
  #pos: number = 0;
  #length: number;

  constructor(s: string) {
    this.#s = s;
    this.#length = s.length;
  }

  match(m: string | RegExp, cb?: (m: string[], pos: number) => void) {
    if (this.eof()) return false;

    const sliced = this.#s.slice(this.#pos);

    const matched =
      typeof m === 'string'
        ? sliced.startsWith(m) && [m]
        : sliced.match(new RegExp(m, 'y'));
    if (matched) {
      cb?.(matched, this.#pos);
      this.skip(matched[0].length);
      return matched;
    }
    return false;
  }

  skipUntil(m: string | RegExp) {
    if (this.eof()) return false;

    const sliced = this.#s.slice(this.#pos);
    const pos = typeof m === 'string' ? sliced.indexOf(m) : sliced.search(m);
    if (pos < 0) return false;
    this.skip(pos);
    return true;
  }

  read(n?: number) {
    if (this.eof()) return '';

    n = n ?? 1;
    const result = this.#s.slice(this.#pos, this.#pos + n);
    this.skip(n);
    return result;
  }

  skip(n?: number) {
    this.#pos += Math.min(n ?? 1, this.#length - this.#pos);
  }

  eof() {
    return this.#length <= this.#pos;
  }

  get position() {
    return this.#pos;
  }
}

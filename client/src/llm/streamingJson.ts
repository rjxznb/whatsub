export class JsonLineParser {
  private buffer = "";

  feed(chunk: string, onObject: (obj: unknown) => void): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.tryParse(line, onObject);
    }
  }

  flush(onObject: (obj: unknown) => void): void {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining) this.tryParse(remaining, onObject);
  }

  private tryParse(line: string, onObject: (obj: unknown) => void): void {
    if (!line) return;
    try {
      onObject(JSON.parse(line));
    } catch {
      // Silently skip — common with prose/markdown wrappers from some models.
    }
  }
}

export interface InvalidJsonLine {
  line: string;
  error: SyntaxError;
}

export class JsonLineParser {
  private buffer = "";

  feed(
    chunk: string,
    onObject: (obj: unknown) => void,
    onInvalid?: (failure: InvalidJsonLine) => void,
  ): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.tryParse(line, onObject, onInvalid);
    }
  }

  flush(
    onObject: (obj: unknown) => void,
    onInvalid?: (failure: InvalidJsonLine) => void,
  ): void {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining) this.tryParse(remaining, onObject, onInvalid);
  }

  private tryParse(
    line: string,
    onObject: (obj: unknown) => void,
    onInvalid?: (failure: InvalidJsonLine) => void,
  ): void {
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      onInvalid?.({
        line,
        error: error instanceof SyntaxError ? error : new SyntaxError(String(error)),
      });
      return;
    }
    try {
      onObject(parsed);
    } catch {
      // Preserve the parser's tolerant handling of consumer/schema failures.
    }
  }
}

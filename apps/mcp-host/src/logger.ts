/**
 * Minimal structured logger for the MCP host.
 * Writes to stderr so Railway captures it in the log stream.
 */

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export class Logger {
  private readonly context: string;

  constructor(context = "mcp-host") {
    this.context = context;
  }

  private write(level: LogLevel, message: string): void {
    const ts = new Date().toISOString();
    process.stderr.write(`[${ts}] [${level}] [${this.context}] ${message}\n`);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  debug(message: string): void {
    if (process.env.DEBUG || process.env.PHANTOM_MCP_DEBUG) {
      this.write("DEBUG", message);
    }
  }

  child(childContext: string): Logger {
    return new Logger(`${this.context}:${childContext}`);
  }
}

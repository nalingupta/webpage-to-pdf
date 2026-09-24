export type PdfErrorCode =
  | "RENDERER_UNAVAILABLE"
  | "RENDERER_FAILED"
  | "WEBSITE_BLOCKED"
  | "WEBSITE_UNREACHABLE"
  | "NAVIGATION_TIMEOUT"
  | "RENDER_TIMEOUT"
  | "PDF_TOO_LARGE";

export class PdfError extends Error {
  constructor(
    public readonly code: PdfErrorCode,
    public readonly status: 502 | 503 | 504,
    public readonly publicMessage: string,
    cause?: unknown,
  ) {
    super(publicMessage, { cause });
    this.name = "PdfError";
  }
}

export function rendererUnavailable(cause?: unknown): PdfError {
  return new PdfError(
    "RENDERER_UNAVAILABLE", 503,
    "The PDF renderer is unavailable on this server. Please try again later.",
    cause,
  );
}
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Downsample embedded photos without rasterizing text or dropping PDF links. */
export async function optimizePdf(input: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "webpage-pdf-"));
  const source = join(directory, "source.pdf");
  const output = join(directory, "optimized.pdf");
  try {
    await writeFile(source, input);
    await execFileAsync("gs", [
      "-dSAFER", "-dBATCH", "-dNOPAUSE", "-q",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.6",
      "-dPDFSETTINGS=/screen",
      "-dColorImageResolution=90",
      "-dGrayImageResolution=90",
      "-dMonoImageResolution=150",
      "-dDetectDuplicateImages=true",
      "-dPreserveAnnots=true",
      `-sOutputFile=${output}`,
      source,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const optimized = await readFile(output);
    if (optimized.subarray(0, 5).toString() !== "%PDF-") {
      throw new Error("PDF optimization did not produce a valid PDF.");
    }
    return optimized.length < input.length ? optimized : input;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
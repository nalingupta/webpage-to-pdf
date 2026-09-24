import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './pdf-renderer.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfRendererProps = {
  data: Uint8Array;
};

type RenderStatus = 'loading' | 'ready' | 'error';

export function PdfRenderer({ data }: PdfRendererProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState<RenderStatus>('loading');

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateWidth = () => {
      const nextWidth = Math.round(viewport.clientWidth);
      setWidth((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const pages = pagesRef.current;
    if (!pages || width === 0) return;

    let cancelled = false;
    let activeTextLayer: TextLayer | null = null;
    setStatus('loading');
    pages.replaceChildren();

    // PDF.js transfers the supplied buffer to its worker, so render from a copy.
    const loadingTask = getDocument({ data: data.slice() });

    const render = async () => {
      try {
        const pdfDocument = await loadingTask.promise;
        const availableWidth = Math.max(280, width - 32);

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          if (cancelled) return;

          const page = await pdfDocument.getPage(pageNumber);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(1.75, availableWidth / unscaledViewport.width);
          const viewport = page.getViewport({ scale });
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width * pixelRatio);
          canvas.height = Math.ceil(viewport.height * pixelRatio);
          canvas.style.width = `${Math.ceil(viewport.width)}px`;
          canvas.style.height = `${Math.ceil(viewport.height)}px`;
          canvas.className = 'block max-w-full bg-white shadow-lg';
          canvas.setAttribute('aria-label', `PDF page ${pageNumber}`);
          const canvasContext = canvas.getContext('2d');
          if (!canvasContext) throw new Error('Canvas rendering is unavailable.');

          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'flex w-full justify-center';
          pageWrapper.id = `pdf-preview-page-${pageNumber}`;
          const pageSurface = document.createElement('div');
          pageSurface.className = 'pdf-page-surface';
          pageSurface.style.width = `${viewport.width}px`;
          pageSurface.style.height = `${viewport.height}px`;
          pageSurface.style.setProperty('--scale-factor', String(scale));
          pageSurface.appendChild(canvas);
          pageWrapper.appendChild(pageSurface);
          pages.appendChild(pageWrapper);

          await page.render({
            canvasContext,
            viewport,
            transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
          }).promise;
          if (cancelled) return;

          const textLayerElement = document.createElement('div');
          textLayerElement.className = 'textLayer pdf-text-layer';
          textLayerElement.setAttribute('aria-label', `Text on PDF page ${pageNumber}`);
          pageSurface.appendChild(textLayerElement);
          activeTextLayer = new TextLayer({
            textContentSource: await page.getTextContent(),
            container: textLayerElement,
            viewport,
          });
          if (cancelled) return;
          await activeTextLayer.render();
          activeTextLayer = null;
          if (cancelled) return;

          const annotations = await page.getAnnotations({ intent: 'display' });
          if (cancelled) return;
          const linkLayer = document.createElement('div');
          linkLayer.className = 'pdf-link-layer';
          for (const annotation of annotations) {
            if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect)) continue;

            const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const link = document.createElement('a');
            link.className = 'pdf-page-link';
            link.style.left = `${left}px`;
            link.style.top = `${top}px`;
            link.style.width = `${Math.abs(x2 - x1)}px`;
            link.style.height = `${Math.abs(y2 - y1)}px`;

            if (typeof annotation.url === 'string') {
              let url: URL;
              try {
                url = new URL(annotation.url);
              } catch {
                continue;
              }
              if (!['http:', 'https:'].includes(url.protocol)) continue;
              link.href = url.href;
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
              link.setAttribute('aria-label', `Open PDF link: ${url.href}`);
            } else if (annotation.dest) {
              link.href = '#';
              link.setAttribute('aria-label', 'Go to linked PDF page');
              link.addEventListener('click', async (event) => {
                event.preventDefault();
                const destination = typeof annotation.dest === 'string'
                  ? await pdfDocument.getDestination(annotation.dest)
                  : annotation.dest;
                const pageRef = destination?.[0];
                if (!pageRef) return;
                const targetPage = typeof pageRef === 'object'
                  ? (await pdfDocument.getPageIndex(pageRef)) + 1
                  : pageRef + 1;
                if (!cancelled) pages.querySelector(`#pdf-preview-page-${targetPage}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              });
            } else {
              continue;
            }
            linkLayer.appendChild(link);
          }
          pageSurface.appendChild(linkLayer);
          page.cleanup();
        }

        if (!cancelled) setStatus('ready');
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
          console.error(`Failed to render PDF: ${message}`);
          setStatus('error');
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
      activeTextLayer?.cancel();
      pages.replaceChildren();
      void loadingTask.destroy();
    };
  }, [data, width]);

  return (
    <div
      ref={viewportRef}
      aria-label="Generated PDF"
      className="relative w-full overflow-auto rounded-2xl bg-muted/50 p-3 md:p-4"
    >
      {status === 'loading' && (
        <div role="status" className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Rendering PDF…
        </div>
      )}
      {status === 'error' && (
        <div role="alert" className="flex min-h-64 items-center justify-center text-sm text-destructive">
          The PDF could not be rendered.
        </div>
      )}
      <div
        ref={pagesRef}
        className={status === 'loading' ? 'hidden' : 'flex flex-col items-center gap-4'}
      />
    </div>
  );
}
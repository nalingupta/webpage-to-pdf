import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Download, Globe, FileText, Loader2, Printer } from 'lucide-react';
import { PdfRenderer } from '@/components/pdf-renderer';

const formSchema = z.object({
  url: z.string().url({ message: "Please enter a valid URL (e.g., https://example.com)." })
    .refine((value) => /^https?:\/\//i.test(value), "Only http:// and https:// URLs are supported."),
  hideNotices: z.boolean(),
  expandedCapture: z.boolean(),
});

export default function Home() {
  const { toast } = useToast();
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [pdfResult, setPdfResult] = useState<{ data: Uint8Array; filename: string } | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      url: "",
      hideNotices: true,
      expandedCapture: true,
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setIsGenerating(true);
    setProgress(5);
    setProgressText("Preparing PDF capture…");
    const requestId = crypto.randomUUID();
    const percentages: Record<string, number> = {
      starting: 5, loading: 20, removing: 45, expanding: 60,
      carousels: 78, rendering: 87, complete: 100,
    };
    let polling = false;
    const progressInterval = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await fetch(`/api/pdf/progress/${requestId}`, { cache: 'no-store' });
        if (result.ok) {
          const status: { stage: string; message: string } = await result.json();
          setProgressText(status.message);
          setProgress((prev) => Math.max(prev, percentages[status.stage] || prev));
        }
      } catch {
        // The main request will report any connection error.
      } finally {
        polling = false;
      }
    }, 500);

    try {
      const response = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          pageSize: "A4",
          orientation: "portrait",
          requestId,
        }),
      });

      clearInterval(progressInterval);
      if (!response.ok) {
        let errorMessage = `Server error: ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error) errorMessage = errorData.error;
        } catch (e) {
          // Keep default error message
        }
        throw new Error(errorMessage);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const suggestedFilename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/i)?.[1];
      const filename = suggestedFilename?.replace(/[^a-z0-9._-]/gi, '-') ||
        `${new URL(values.url).hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 90)}.pdf`;
      setProgress(100);
      setProgressText("PDF ready. Rendering preview…");
      setPdfResult({ data: bytes, filename });
      
      toast({
        title: "Success",
        description: "PDF generated and rendered below.",
      });
      
      form.reset();
    } catch (error) {
      clearInterval(progressInterval);
      setProgress(0);
      setProgressText("");
      toast({
        title: "Error generating PDF",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
      setTimeout(() => {
        setProgress(0);
        setProgressText("");
      }, 1500);
    }
  };

  const downloadPdf = () => {
    if (!pdfResult) return;
    const blob = new Blob([new Uint8Array(pdfResult.data)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = pdfResult.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Keep the object URL alive long enough for the browser to finish saving.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  return (
    <div className="min-h-[100dvh] w-full bg-grid bg-background flex flex-col items-center justify-center p-4 md:p-8 font-sans">
      <div className="w-full max-w-5xl flex flex-col gap-8">
        
        {/* Header */}
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mb-1">
            <Printer className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground">
            Webpage to PDF
          </h1>
          <p className="text-muted-foreground font-mono text-sm max-w-sm leading-relaxed">
            Reliable, high-fidelity document generation from any public URL.
          </p>
        </div>

        {/* Main Card */}
        <div className="w-full max-w-xl mx-auto bg-card shadow-2xl shadow-primary/5 border border-border/60 rounded-3xl p-6 md:p-10">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
              
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[11px] font-mono uppercase tracking-widest font-bold text-muted-foreground mb-1 block">
                      Target URL
                    </FormLabel>
                    <FormControl>
                      <div className="relative group">
                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                          <Globe className={`w-5 h-5 transition-colors ${form.formState.errors.url ? 'text-destructive' : 'text-muted-foreground group-focus-within:text-primary'}`} />
                        </div>
                        <Input 
                          placeholder="https://en.wikipedia.org/wiki/Typography" 
                          className="pl-12 h-14 text-base md:text-lg bg-background border-2 transition-all duration-200 focus-visible:ring-0 focus-visible:border-primary shadow-sm rounded-xl"
                          {...field} 
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="pt-4">
                <Button 
                  type="submit" 
                  size="lg" 
                  className="w-full h-14 rounded-xl text-base font-bold relative overflow-hidden transition-all duration-300 shadow-lg hover:shadow-xl hover:-translate-y-0.5"
                  disabled={isGenerating}
                >
                  <div className="relative z-10 flex items-center justify-center gap-2 w-full">
                    {isGenerating ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                         <span>Creating PDF…</span>
                      </>
                    ) : (
                      <>
                        <FileText className="w-5 h-5" />
                        <span>Create PDF</span>
                      </>
                    )}
                  </div>
                  
                  {isGenerating && (
                    <div 
                      className="absolute bottom-0 left-0 h-full bg-black/10 transition-all duration-300 ease-out z-0" 
                      style={{ width: `${progress}%` }}
                    />
                  )}
                </Button>
                {isGenerating && (
                  <p role="status" aria-live="polite" className="mt-3 text-center text-xs font-mono text-muted-foreground">
                    {progressText}
                  </p>
                )}
              </div>

            </form>
          </Form>
        </div>

        {pdfResult && (
          <section className="w-full rounded-3xl border border-border/60 bg-card p-3 md:p-5 shadow-2xl shadow-primary/5">
            <div className="flex flex-col gap-3 px-1 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground">Your PDF is ready</h2>
                <p className="truncate text-sm text-muted-foreground" title={pdfResult.filename}>{pdfResult.filename}</p>
              </div>
              <Button type="button" variant="outline" onClick={downloadPdf} data-testid="button-download-pdf"
                className="w-full gap-2 sm:w-auto">
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
            </div>
            <PdfRenderer data={pdfResult.data} />
          </section>
        )}

        {/* Footer */}
        <div className="text-center">
          <p className="text-xs text-muted-foreground font-mono opacity-60">
            Powered by headless browser automation
          </p>
        </div>

      </div>
    </div>
  );
}

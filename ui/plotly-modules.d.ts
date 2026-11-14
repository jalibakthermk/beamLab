/**
 * Minimal typings for the parts of Plotly used here. The project imports
 * Plotly's CommonJS source modules (core + heatmap) to keep the
 * bundle small; those modules ship without TypeScript types.
 */
declare module 'plotly.js/lib/core' {
  export interface PlotlyHTMLElement extends HTMLDivElement {
    on(event: string, handler: (data: unknown) => void): void;
    removeAllListeners?(event: string): void;
  }
  export interface PlotlyStatic {
    register(modules: unknown[]): void;
    react(el: HTMLElement, data: object[], layout?: object, config?: object): Promise<PlotlyHTMLElement>;
    relayout(el: HTMLElement, update: object): Promise<PlotlyHTMLElement>;
    purge(el: HTMLElement): void;
    downloadImage(el: HTMLElement, opts: { format: 'png'; filename: string; width?: number; height?: number }): Promise<string>;
    Plots: { resize(el: HTMLElement): Promise<void> | void };
  }
  const Plotly: PlotlyStatic;
  export default Plotly;
}
declare module 'plotly.js/lib/heatmap' {
  const m: unknown;
  export default m;
}

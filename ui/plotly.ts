// Minimal Plotly bundle: core (includes scatter) + heatmap only.
// Contour lines are computed in core/analysis/contours.ts and drawn as scatter lines.
import Plotly from 'plotly.js/lib/core';
import heatmap from 'plotly.js/lib/heatmap';

Plotly.register([heatmap]);

export default Plotly;
export type { PlotlyHTMLElement } from 'plotly.js/lib/core';

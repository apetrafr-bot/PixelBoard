# PixelBoard visual system

## Direction

PixelBoard is a pixel-art workbench, not a generic note dashboard. A deep green working canvas, precise alignment grid, compact tool rail, and tactile cards evoke a small sprite atelier. The grid appears only on the navigable board, where it helps users judge placement and pixel scale.

## Palette and type

- Work surface: forest ink `#173A35`, with a subtle `24px` coordinate grid.
- Navigation and tool chrome: dark green `#19332E`, separated by quiet green rules.
- Primary action: chartreuse `#D7F36A`, reserved for the next deliberate action and selected markers.
- Supporting art colors: mint, warm yellow, coral, and sky blue, held to note accents and image material.
- Cards use warm, high-contrast paper colors with dark-green text and hard-edged borders.
- System sans-serif supports editing and scanning; monospace labels identify canvas measurements and compact UI state.

## Layout and components

- A narrow, dark tool rail frames a light workspace header; the green, pannable canvas is the dominant region.
- The coordinate grid belongs only to the actual work surface, supporting spatial placement rather than decorating the surrounding UI.
- Notes, links, tasks, and nested boards are editable hard-edged paper pieces; images sit inside a checkerboard plate and retain pixelated scaling.
- Team profiles and task lists live in a slide-over workspace panel. Local-only status remains explicit without a configured API; shared mode identifies the signed-in workspace and owner/member permissions.
- Card borders and small offset shadows intentionally use hard edges, echoing pixel boundaries rather than soft dashboard elevation.
- The board remains a spatial, scrollable canvas on touch-sized layouts; navigation contracts to an icon rail.

## States and accessibility

- Saving, storage failure, empty board, selected cards, keyboard focus, and unavailable Milanote import are explicit.
- Card move handles support pointer drag and arrow-key movement; Shift+arrow moves farther.
- Respect reduced-motion preferences and maintain visible keyboard focus.
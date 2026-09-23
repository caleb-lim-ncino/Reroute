// TfL line colours (brand palette, including the 2024 Overground line names). `ink` is the
// text colour that stays legible on the line colour. Bakerloo and Windrush are nudged a
// shade darker than brand, and DLR/Victoria take dark ink, so every pill clears WCAG 4.5:1.
export interface LineStyle {
  name: string;
  colour: string;
  ink: string;
}

const LIGHT = "#fff";
const DARK = "#111";

export const LINE_STYLES: Record<string, LineStyle> = {
  bakerloo: { name: "Bakerloo", colour: "#A65C04", ink: LIGHT },
  central: { name: "Central", colour: "#E32017", ink: LIGHT },
  circle: { name: "Circle", colour: "#FFD300", ink: DARK },
  district: { name: "District", colour: "#00782A", ink: LIGHT },
  "hammersmith-city": { name: "H&C", colour: "#F3A9BB", ink: DARK },
  jubilee: { name: "Jubilee", colour: "#A0A5A9", ink: DARK },
  metropolitan: { name: "Metropolitan", colour: "#9B0056", ink: LIGHT },
  northern: { name: "Northern", colour: "#000000", ink: LIGHT },
  piccadilly: { name: "Piccadilly", colour: "#003688", ink: LIGHT },
  victoria: { name: "Victoria", colour: "#0098D4", ink: DARK },
  "waterloo-city": { name: "W&C", colour: "#95CDBA", ink: DARK },
  dlr: { name: "DLR", colour: "#00A4A7", ink: DARK },
  elizabeth: { name: "Elizabeth", colour: "#6950A1", ink: LIGHT },
  liberty: { name: "Liberty", colour: "#5D6061", ink: LIGHT },
  lioness: { name: "Lioness", colour: "#FAA61A", ink: DARK },
  mildmay: { name: "Mildmay", colour: "#0077AD", ink: LIGHT },
  suffragette: { name: "Suffragette", colour: "#5BBD72", ink: DARK },
  weaver: { name: "Weaver", colour: "#823A62", ink: LIGHT },
  windrush: { name: "Windrush", colour: "#D81A00", ink: LIGHT },
};

const MODE_STYLES: Record<string, LineStyle> = {
  bus: { name: "Bus", colour: "#DC241F", ink: LIGHT },
  walking: { name: "Walk", colour: "#E4E4E4", ink: DARK },
};

const FALLBACK: LineStyle = { name: "", colour: "#6B6B6B", ink: LIGHT };

export function lineStyle(lineId: string | null | undefined, mode?: string): LineStyle {
  return (lineId && LINE_STYLES[lineId]) || (mode && MODE_STYLES[mode]) || FALLBACK;
}

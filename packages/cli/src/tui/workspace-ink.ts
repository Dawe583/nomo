import { PassThrough } from "node:stream";
import { Box, Text, render as renderInk, type Instance } from "ink";
import { createElement, type ReactElement } from "react";

export interface WorkspaceInkFrameProps {
  frame: string;
  columns: number;
  rows: number;
}

export function WorkspaceInkFrame({
  frame,
  columns,
  rows,
}: WorkspaceInkFrameProps): ReactElement {
  const lines = frame.split("\n").slice(0, rows);

  return createElement(
    Box,
    { flexDirection: "column", width: columns, height: rows },
    ...lines.map((line, index) =>
      createElement(Text, { key: index, wrap: "truncate" }, line),
    ),
  );
}

export class WorkspaceInkRenderer {
  private instance: Instance | undefined;

  render(frame: string, columns: number, rows: number): void {
    const node = createElement(WorkspaceInkFrame, { frame, columns, rows });
    if (this.instance) {
      this.instance.rerender(node);
      return;
    }

    this.instance = renderInk(node, {
      stdin: new PassThrough(),
      stdout: process.stdout,
      interactive: true,
      alternateScreen: false,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    });
  }

  redraw(): void {
    this.instance?.clear();
  }

  unmount(): void {
    const instance = this.instance;
    this.instance = undefined;
    if (!instance) return;

    instance.unmount();
    instance.cleanup();
  }
}

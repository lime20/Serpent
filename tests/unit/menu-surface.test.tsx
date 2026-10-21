// @vitest-environment happy-dom
import { act, Fragment, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MenuSurface,
  resolveMenuNodes,
  type ResolvedMenuNode,
} from "../../src/renderer/ui/patterns/menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const nodes = resolveMenuNodes([
  { kind: "item", id: "alpha", label: "Alpha", command: "alpha.run" },
  { kind: "item", id: "beta", label: "Beta", command: "beta.run" },
]);

function StatefulRow({ node }: { node: ResolvedMenuNode }) {
  const [initialId] = useState(node.id);
  return (
    <button role="menuitem" data-node-id={node.id} data-initial-id={initialId}>
      {node.label}
    </button>
  );
}

describe("MenuSurface", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("accepts unkeyed row fragments without a React key warning or extra DOM", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      root.render(
        <MenuSurface
          nodes={nodes}
          renderNode={(node) => (
            <>
              <StatefulRow node={node} />
            </>
          )}
        />,
      );
    });

    expect(consoleError).not.toHaveBeenCalled();
    const surface = container.querySelector('[role="menu"]');
    expect(surface?.children.length).toBe(2);
    expect(Array.from(surface?.children ?? []).map((child) => child.getAttribute("role")))
      .toEqual(["menuitem", "menuitem"]);
  });

  it.each(["element", "fragment"])(
    "preserves row state by node id when %s rows reorder",
    async (kind) => {
      const renderNode = (node: ResolvedMenuNode): ReactNode => {
        const row = <StatefulRow node={node} />;
        return kind === "fragment" ? <Fragment>{row}</Fragment> : row;
      };
      await act(async () => root.render(<MenuSurface nodes={nodes} renderNode={renderNode} />));
      const betaRow = container.querySelector('[data-node-id="beta"]');

      await act(async () => {
        root.render(<MenuSurface nodes={[...nodes].reverse()} renderNode={renderNode} />);
      });

      const firstRow = container.querySelector('[role="menu"]')?.firstElementChild;
      expect(firstRow).toBe(betaRow);
      expect(firstRow?.getAttribute("data-initial-id")).toBe("beta");
      expect(firstRow?.textContent).toBe("Beta");
    },
  );
});

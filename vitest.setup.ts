import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Testing Library only auto-unmounts when Vitest runs with `globals: true`,
// which this project does not. Without it every render in a file stacks up in
// the same document and queries start finding several of everything.
afterEach(cleanup);

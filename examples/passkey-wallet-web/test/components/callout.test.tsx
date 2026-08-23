import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Callout } from "../../src/components/Callout.tsx";

test("tone is carried by a class, never by the text alone", () => {
  const { container } = render(<Callout tone="danger" title="Cannot be undone"><p>Detail</p></Callout>);
  expect(container.querySelector(".callout.danger")).not.toBeNull();
  expect(screen.getByText("Cannot be undone")).toBeTruthy();
});

// A person who cannot see the colour still has to learn that what they pressed
// did something, so outcomes are announced rather than only recoloured.
test("an outcome announces itself to assistive technology", () => {
  render(<Callout live title="Copied"><p>Done</p></Callout>);
  expect(screen.getByRole("status")).toBeTruthy();
});

test("a plain remark neither announces nor demands a title", () => {
  const { container } = render(<Callout><p>Just a note</p></Callout>);
  expect(container.querySelector("[role='status']")).toBeNull();
  expect(container.querySelector(".callout")?.className).toBe("callout");
  expect(screen.getByText("Just a note")).toBeTruthy();
});

test("every tone maps to a distinct class", () => {
  const classes = (["neutral", "success", "warning", "danger"] as const).map(tone => {
    const { container } = render(<Callout tone={tone}>x</Callout>);
    return container.querySelector("div")?.className;
  });
  expect(new Set(classes).size).toBe(4);
});

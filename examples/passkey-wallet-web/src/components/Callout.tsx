import type { ReactNode } from "react";

/**
 * A short statement about the account's situation, in the app's own vocabulary.
 *
 * The pattern was written out by hand sixty-two times -- `callout`,
 * `callout warning`, `callout success` -- each with its own arrangement of
 * `<strong>` and `<p>`. Some carried a heading, some did not; some announced
 * themselves to assistive technology, most did not. The result read as a
 * different component every few screens.
 *
 * Tone is a claim about consequence, not decoration:
 *   neutral  something true and unremarkable
 *   success  something finished, verified where verification applies
 *   warning  something the reader has to decide about
 *   danger   something that cannot be undone
 *
 * Status changes are announced, because a person who cannot see the colour
 * still has to learn that the thing they pressed did something. Colour alone
 * never carries the meaning: every tone also has a word.
 */
export type CalloutTone = "neutral" | "success" | "warning" | "danger";

const TONE_CLASS: Readonly<Record<CalloutTone, string>> = Object.freeze({
  neutral: "callout",
  success: "callout success",
  warning: "callout warning",
  danger: "callout danger"
});

export function Callout({ tone = "neutral", title, live = false, children }: {
  readonly tone?: CalloutTone;
  /** A short statement, not a category label. Optional for a bare remark. */
  readonly title?: string;
  /** Announce changes to assistive technology. Use for action outcomes. */
  readonly live?: boolean;
  readonly children?: ReactNode;
}) {
  return <div className={TONE_CLASS[tone]} {...(live ? { role: "status" } : {})}>
    {title ? <strong>{title}</strong> : null}
    {children}
  </div>;
}

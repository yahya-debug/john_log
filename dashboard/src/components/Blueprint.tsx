import type { PropsWithChildren, HTMLAttributes } from 'react';

/**
 * The wireframe frame every card, figure and primary button wears in Industry:
 * square corners, hairline border, four "+" registration marks.
 * Never drop the marks from a framed element.
 */
export function Blueprint({
  children,
  className = '',
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={`blueprint ${className}`.trim()} {...rest}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}

/** Panel = blueprint frame + the standard 20px inset used across the dashboard. */
export function Panel({ children, style, ...rest }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Blueprint style={{ padding: 20, ...style }} {...rest}>
      {children}
    </Blueprint>
  );
}

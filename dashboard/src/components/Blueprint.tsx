import type { PropsWithChildren, HTMLAttributes, CSSProperties } from 'react';

const cardStyle: CSSProperties = {
  background: '#ffffff',
  border: '1px solid var(--color-divider)',
  borderRadius: 8,
};

/** Card = the white, rounded-corner frame every panel in Industry wears. */
export function Blueprint({
  children,
  className = '',
  style,
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={className} style={{ ...cardStyle, ...style }} {...rest}>
      {children}
    </div>
  );
}

/** Panel = Blueprint card + the standard 20px inset used across the dashboard. */
export function Panel({ children, style, ...rest }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Blueprint style={{ padding: 20, ...style }} {...rest}>
      {children}
    </Blueprint>
  );
}

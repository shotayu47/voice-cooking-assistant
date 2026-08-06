import type { ButtonHTMLAttributes } from 'react';
import Link from 'next/link';

import { cn } from '@/lib/cn';

/**
 * Every size here clears the 44px minimum touch target (SPEC §18).
 * `xl` is the cooking-mode size: reachable and hittable without looking.
 */
const SIZES = {
  sm: 'min-h-11 px-3 text-sm',
  md: 'min-h-12 px-4 text-base',
  lg: 'min-h-14 px-5 text-lg',
  xl: 'min-h-[72px] px-6 text-xl',
} as const;

const VARIANTS = {
  primary: 'bg-accent text-on-accent font-bold active:bg-accent-strong',
  secondary: 'bg-surface-2 text-fg border border-line active:bg-line',
  ghost: 'bg-transparent text-muted active:bg-surface-2',
  danger: 'bg-transparent text-danger border border-danger/40 active:bg-danger/10',
} as const;

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl select-none transition-colors disabled:opacity-40 disabled:pointer-events-none';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  block?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE, SIZES[size], VARIANTS[variant], block && 'w-full', className)}
      {...props}
    />
  );
}

export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  block,
  className,
  children,
}: {
  href: string;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  block?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(BASE, SIZES[size], VARIANTS[variant], block && 'w-full', className)}
    >
      {children}
    </Link>
  );
}

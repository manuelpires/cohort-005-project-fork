import { BookOpen, Clock, GraduationCap, type LucideIcon } from "lucide-react";

export type LandingLink = { label: string; href: string };

export type LandingCta = LandingLink & {
  variant: "default" | "outline";
  icon?: boolean;
};

export type LandingStat = { value: string; label: string; icon: LucideIcon };

export type LandingContent = {
  hero: {
    eyebrow: string;
    eyebrowClassName: string;
    headlineLead: string;
    headlineMuted: string;
    headlineClassName: string;
    description: string;
    ctas: LandingCta[];
    className: string;
    descriptionClassName: string;
    ctaRowClassName: string;
  };
  stats: {
    items: LandingStat[];
    className: string;
    itemClassName: string;
  };
  footer: {
    brand: string;
    tagline: string;
    links: LandingLink[];
    className: string;
  };
};

type LandingInput = {
  totalCourses: number;
  totalCategories: number;
  signedIn: boolean;
};

/**
 * Every class string this module emits aligns content to the left: the
 * landing page is the page that must not drift back to `text-center`, so the
 * decision lives here where a test can pin it, not in the route's JSX.
 */
export function buildLandingContent(input: LandingInput): LandingContent {
  return {
    hero: buildHero(input.signedIn),
    stats: buildStats(input),
    footer: buildFooter(input.signedIn),
  };
}

function accountHref(signedIn: boolean): string {
  return signedIn ? "/dashboard" : "/signup";
}

function buildHero(signedIn: boolean): LandingContent["hero"] {
  const accountCta: LandingCta = {
    label: signedIn ? "Go to dashboard" : "Create an account",
    href: accountHref(signedIn),
    variant: "outline",
  };

  return {
    eyebrow: "Built for developers",
    eyebrowClassName:
      "text-sm font-medium uppercase tracking-widest text-primary",
    headlineLead: "Learn to code,",
    headlineMuted: "at your own pace",
    headlineClassName:
      "mt-4 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl",
    description:
      "Structured courses built by experienced instructors. Track your progress, take quizzes, and build real-world skills.",
    ctas: [
      {
        label: "Browse courses",
        href: "/courses",
        variant: "default",
        icon: true,
      },
      accountCta,
    ],
    className: "mx-auto max-w-6xl px-6 py-20 text-left sm:py-28",
    descriptionClassName: "mt-6 max-w-2xl text-lg text-muted-foreground",
    ctaRowClassName: "mt-10 flex items-center justify-start gap-4",
  };
}

function buildStats(input: LandingInput): LandingContent["stats"] {
  const { totalCourses, totalCategories } = input;

  const items: LandingStat[] = [
    {
      value: String(totalCourses),
      label: "Available Courses",
      icon: BookOpen,
    },
    {
      value: String(totalCategories),
      label: "Categories",
      icon: GraduationCap,
    },
    { value: "Self-paced", label: "Learn on your schedule", icon: Clock },
  ];

  return {
    items,
    className: "border-y border-border bg-muted/50 py-16",
    itemClassName: "text-left",
  };
}

function buildFooter(signedIn: boolean): LandingContent["footer"] {
  const accountLink: LandingLink = {
    label: signedIn ? "Dashboard" : "Sign up",
    href: accountHref(signedIn),
  };

  return {
    brand: "Cadence",
    tagline: "Learn at your own pace.",
    links: [{ label: "Courses", href: "/courses" }, accountLink],
    className:
      "mx-auto flex max-w-6xl flex-col gap-3 px-6 text-left text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between",
  };
}

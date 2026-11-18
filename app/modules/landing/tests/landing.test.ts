import { describe, it, expect } from "vitest";
import { BookOpen, Clock, GraduationCap } from "lucide-react";
import { buildLandingContent } from "../index";

const signedOut = buildLandingContent({
  totalCourses: 4,
  totalCategories: 5,
  signedIn: false,
});

const signedIn = buildLandingContent({
  totalCourses: 4,
  totalCategories: 5,
  signedIn: true,
});

describe("buildLandingContent", () => {
  it("left-aligns every section: no centering class survives anywhere", () => {
    const classSlots = [
      signedOut.hero.className,
      signedOut.hero.eyebrowClassName,
      signedOut.hero.headlineClassName,
      signedOut.hero.descriptionClassName,
      signedOut.hero.ctaRowClassName,
      signedOut.stats.className,
      signedOut.stats.itemClassName,
      signedOut.footer.className,
    ];

    for (const classes of classSlots) {
      expect(classes).not.toContain("text-center");
      expect(classes).not.toContain("justify-center");
    }

    expect(signedOut.hero.ctaRowClassName).toContain("justify-start");
    expect(signedOut.hero.descriptionClassName).not.toContain("mx-auto");
    expect(signedOut.stats.itemClassName).toBe("text-left");
  });

  it("keeps the band and copy styles the page already had, left-aligned", () => {
    expect(signedOut.hero.eyebrowClassName).toBe(
      "text-sm font-medium uppercase tracking-widest text-primary"
    );
    expect(signedOut.hero.headlineClassName).toBe(
      "mt-4 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
    );
    expect(signedOut.hero.descriptionClassName).toBe(
      "mt-6 max-w-2xl text-lg text-muted-foreground"
    );
    expect(signedOut.stats.className).toBe(
      "border-y border-border bg-muted/50 py-16"
    );
  });

  it("keeps the page container centered while its content hugs the left", () => {
    expect(signedOut.hero.className).toContain("mx-auto max-w-6xl");
    expect(signedOut.hero.className).toContain("text-left");
    expect(signedOut.footer.className).toContain("text-left");
  });

  it("writes the hero: eyebrow, two-line headline, copy, and two CTAs", () => {
    expect(signedOut.hero.eyebrow).toBe("Built for developers");
    expect(signedOut.hero.headlineLead).toBe("Learn to code,");
    expect(signedOut.hero.headlineMuted).toBe("at your own pace");
    expect(signedOut.hero.description).toBe(
      "Structured courses built by experienced instructors. Track your progress, take quizzes, and build real-world skills."
    );
    expect(signedOut.hero.ctas).toEqual([
      {
        label: "Browse courses",
        href: "/courses",
        variant: "default",
        icon: true,
      },
      { label: "Create an account", href: "/signup", variant: "outline" },
    ]);
  });

  it("sends signed-in visitors to their dashboard instead of signup", () => {
    expect(signedIn.hero.ctas[1]).toEqual({
      label: "Go to dashboard",
      href: "/dashboard",
      variant: "outline",
    });
    expect(signedIn.footer.links.at(-1)).toEqual({
      label: "Dashboard",
      href: "/dashboard",
    });
  });

  it("derives the stats band from the catalog counts", () => {
    expect(signedOut.stats.items).toEqual([
      { value: "4", label: "Available Courses", icon: BookOpen },
      { value: "5", label: "Categories", icon: GraduationCap },
      { value: "Self-paced", label: "Learn on your schedule", icon: Clock },
    ]);

    const busier = buildLandingContent({
      totalCourses: 12,
      totalCategories: 3,
      signedIn: false,
    });
    expect(busier.stats.items[0].value).toBe("12");
    expect(busier.stats.items[1].value).toBe("3");
  });

  it("names the product in the footer and links into the catalog", () => {
    expect(signedOut.footer.brand).toBe("Cadence");
    expect(signedOut.footer.tagline).toBe("Learn at your own pace.");
    expect(signedOut.footer.links).toEqual([
      { label: "Courses", href: "/courses" },
      { label: "Sign up", href: "/signup" },
    ]);
  });
});

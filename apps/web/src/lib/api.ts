// apps/web/src/lib/api.ts
// What the console knows about the api it fronts. The namespace is part of
// every request the api takes (create bodies carry it, id-addressed routes
// take ?namespace=); absence resolves to this default, and the console has
// no namespace switcher yet, so it addresses exactly this one.
export const DEFAULT_NAMESPACE = "default";

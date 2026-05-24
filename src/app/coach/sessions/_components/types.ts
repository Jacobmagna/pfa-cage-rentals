// Shared types for the coach session surface. Lives at /coach/sessions/_components/
// so all three consumers (the new-session form, the edit dialog, and
// the history list) import from one canonical location instead of
// reaching across the route tree.

export type ResourceOption = {
  id: string;
  name: string;
  type: "cage" | "bullpen" | "weight_room";
};

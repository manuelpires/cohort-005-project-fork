// PROTOTYPE — throwaway icon mapping for the Notification Feed UI prototype.
// Not production code; lives on the prototype branch only.
import { GraduationCap, MessageSquare, Receipt, UsersRound } from "lucide-react";
import type { NotificationMeta } from "./catalogue";

export function MetaIcon({ meta, className }: { meta: NotificationMeta; className?: string }) {
  const props = { className };
  switch (meta.icon) {
    case "cap":
      return <GraduationCap {...props} />;
    case "receipt":
      return <Receipt {...props} />;
    case "users":
      return <UsersRound {...props} />;
    default:
      return <MessageSquare {...props} />;
  }
}

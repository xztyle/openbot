/*
 * The sidebar's icons, by their role: Lucide icons from `../../icons`, so the sidebar draws from
 * the same set as the rest of the app. The classes that the stylesheets size and colour
 * (`sidebar-toggle-icon`, `agent-context-icon`) stay on the icon.
 */
import { PanelLeft, Pencil, Plus, Search, Trash2 } from "../../icons";

export function SearchIcon() {
  return <Search aria-hidden="true" class="ui-icon-md" />;
}

export function PlusIcon() {
  return <Plus aria-hidden="true" class="ui-icon-lg" />;
}

export function SidebarToggleIcon() {
  return <PanelLeft aria-hidden="true" class="sidebar-toggle-icon" />;
}

export function EditIcon() {
  return <Pencil aria-hidden="true" class="agent-context-icon ui-icon-md" />;
}

export function DeleteIcon() {
  return <Trash2 aria-hidden="true" class="agent-context-icon agent-context-danger-icon ui-icon-md" />;
}

import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/plugin";

export const messages = {
  "plugin.link.website": "Sitio web",
  "plugin.link.privacyPolicy": "Política de privacidad",
  "plugin.link.terms": "Condiciones del servicio",
  "plugin.copyLink": "Copiar enlace",
  "plugin.askPrompt": "Pregunta a {name}: {prompt}",
  "plugin.section.apps": "Apps",
  "plugin.section.skills": "Habilidades",
  "plugin.skillsPerAgent":
    "La app funciona para cada agente que permitas. Las habilidades le dicen a un agente cómo usarla, y cada agente tiene las suyas.",
  "plugin.skillsName": "Habilidades de {name}",
  "plugin.section.information": "Información",
  "plugin.info.developer": "Desarrollador",
  "plugin.info.category": "Categoría",
  "plugin.info.version": "Versión",
  "plugin.uninstallDialog.title": "¿Desconectar {name}?",
  "plugin.uninstallDialog.description":
    "Esto elimina lo que {name} instaló en este equipo. No cambia nada más en este host ni en este agente.",
  "plugin.uninstallDialog.descriptionOnHost":
    "Esto quita lo que {name} instaló en {host}. No cambia nada más en este host ni en este agente.",
  "plugin.uninstallDialog.confirm": "Desconectar",
  "plugin.uninstallDialog.appsLabel": "Apps que se eliminarán: {number}",
  "plugin.uninstallDialog.appsTitle": "Apps eliminadas de este host",
  "plugin.uninstallDialog.appsNote":
    "Sus herramientas dejan de estar disponibles y se olvidan los datos de inicio de sesión que Atelier guardaba para ellas.",
  "plugin.uninstallDialog.skillsLabel": "Habilidades que se eliminarán: {number}",
  "plugin.uninstallDialog.skillsTitle": "Habilidades eliminadas de {agentName}",
} as const satisfies PartialTranslation<typeof source>;

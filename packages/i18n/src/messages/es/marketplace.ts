import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/marketplace";

export const messages = {
  "marketplace.app.addAccount": "Agregar cuenta",
  "marketplace.category.coding": "Programación",
  "marketplace.category.design": "Diseño",
  "marketplace.category.dataAnalytics": "Datos y análisis",
  "marketplace.category.documents": "Documentos",
  "marketplace.category.productivity": "Productividad",
  "marketplace.category.research": "Investigación",
  "marketplace.category.automation": "Automatización",
  "marketplace.category.other": "Otros",
  "marketplace.loadFailed": "No se pudo cargar el marketplace.",
  "marketplace.loading.skills": "Cargando habilidades",
  "marketplace.loading.agents": "Cargando agentes",
  "marketplace.noMatch.skills": "Ninguna habilidad coincide con esta búsqueda.",
  "marketplace.noMatch.agents": "Ningún agente coincide con esta búsqueda.",
  "marketplace.loadMore": "Cargar más",
  "marketplace.version": "Versión {version}",
  "marketplace.title": "Marketplace",
  "marketplace.close": "Cerrar marketplace",
  "marketplace.kinds": "Tipos de contenido del marketplace",
  "marketplace.tab.agents": "Agentes",
  "marketplace.tab.skills": "Habilidades",
  "marketplace.plugins.missing": "Este plugin no está en el catálogo de Atelier.",
  "marketplace.agents.loadingDetail": "Cargando detalles del agente…",
  "marketplace.agents.skills": "Habilidades",
  "marketplace.agents.routines": "Rutinas",
  "marketplace.agents.routineActive": "Activa",
  "marketplace.agents.routineInactive": "Inactiva",
  "marketplace.skill.loading": "Cargando habilidad",
  "marketplace.skill.update": "Actualizar habilidad",
  "marketplace.skill.updateAvailable": "Actualización disponible",
  "marketplace.skill.remove.titleMany": "¿Quitar {name} de {agents}?",
  "marketplace.skill.remove.many":
    "Atelier quita {name} de cada uno de estos agentes. El historial de chat se conserva.",
  "marketplace.skill.remove.modifiedMany":
    "Algunos de estos agentes tienen cambios locales en los archivos de la habilidad. Al quitarla se borran esos archivos. El historial de chat se conserva.",
  "marketplace.skill.updates.label": "Actualizaciones de habilidades",
  "marketplace.skill.updates.count": {
    one: "{count} habilidad instalada tiene una actualización.",
    other: "{count} habilidades instaladas tienen actualizaciones.",
  },
  "marketplace.skill.updates.all": "Actualizar todas",
  "marketplace.try.readFailed": "Atelier no pudo leer las habilidades de este agente. Inténtalo de nuevo.",
  "marketplace.try.enable": "Activa esta habilidad en los ajustes del agente para probarla.",
  "marketplace.try.repair": "Repara esta habilidad en los ajustes del agente para probarla.",
  "marketplace.try.update": "Actualiza esta habilidad para probar esta versión.",
  "marketplace.try.composerUnavailable": "El editor de mensajes del agente no está disponible.",
  "marketplace.open": "Abrir {name}",
  "marketplace.tab.apps": "Apps",
  "marketplace.crumbs.label": "Ubicación",
  "marketplace.search.label": "Buscar en el marketplace",
  "marketplace.search.placeholder": "Buscar",
  "marketplace.installs": {
    one: "{installs} instalación",
    other: "{installs} instalaciones",
  },
  "marketplace.filter": "Filtrar",
  "marketplace.filter.on": "Filtro: {filters}",
  "marketplace.filter.all": "Todos",
  "marketplace.filter.status": "Estado",
  "marketplace.filter.category": "Categoría",
  "marketplace.filter.added": "Añadidos",
  "marketplace.filter.notAdded": "Sin añadir",
  "marketplace.filter.installed": "Instalados",
  "marketplace.filter.notInstalled": "Sin instalar",
  "marketplace.filter.updates": "Con actualizaciones",
  "marketplace.filter.clear": "Borrar filtros",
  "marketplace.noMatch.apps": "Ninguna app coincide con esta búsqueda.",
  "marketplace.noMatch.filters": "Ningún resultado coincide con los filtros.",
  "marketplace.noMatch.showAgents": {
    one: "Mostrar {count} agente",
    other: "Mostrar {count} agentes",
  },
  "marketplace.noMatch.showApps": {
    one: "Mostrar {count} app",
    other: "Mostrar {count} apps",
  },
  "marketplace.noMatch.showSkills": {
    one: "Mostrar {count} habilidad",
    other: "Mostrar {count} habilidades",
  },
  "marketplace.empty.agents": "Todavía no hay agentes en el marketplace.",
  "marketplace.empty.apps": "Todavía no hay apps en el marketplace.",
  "marketplace.empty.skills": "Todavía no hay habilidades en el marketplace.",
  "marketplace.properties.agent": "Acerca de este agente",
  "marketplace.properties.skill": "Acerca de esta habilidad",
  "marketplace.properties.creator": "Creador",
  "marketplace.properties.category": "Categoría",
  "marketplace.properties.version": "Versión",
  "marketplace.properties.updated": "Actualización",
  "marketplace.properties.installs": "Instalaciones",
  "marketplace.agent.add": "Añadir",
  "marketplace.agent.addNamed": "Añadir {name}",
  "marketplace.agent.addAgent": "Añadir agente",
  "marketplace.agent.added": "Añadido",
  "marketplace.agent.updateAvailable": "Actualización disponible",
  "marketplace.agent.update": "Actualizar",
  "marketplace.agent.openChat": "Abrir chat",
  "marketplace.app.connect": "Conectar",
  "marketplace.app.reconnect": "Reconectar",
  "marketplace.app.disabled": "Desactivada",
  "marketplace.app.review": "Revisar",
  "marketplace.app.reviewNamed": "Revisar {name}",
  "marketplace.app.accounts": { one: "{count} cuenta", other: "{count} cuentas" },
  "marketplace.app.connectNamed": "Conectar {name}",
  "marketplace.app.checking": "Comprobando…",
  "marketplace.app.reviewAccounts": "Revisar cuentas",
  "marketplace.app.readFailed": "No se pudieron leer las apps de {host}.",
  "marketplace.app.adminOnly": "Solo un dueño o administrador de {server} puede conectar apps.",
  "marketplace.app.adminOnlyThisServer": "Solo un dueño o administrador de este servidor puede conectar apps.",
  "marketplace.app.reconnectNamed": "Reconectar {name}",
  "marketplace.app.connected": "Conectada",
  "marketplace.app.attention": "Requiere atención",
  "marketplace.app.notConnected": "Sin conectar",
  "marketplace.app.connecting": "Conectando…",
  "marketplace.app.custom": "Servidor MCP",
  "marketplace.app.githubTagline": "Repositorios, incidencias y pull requests",
  "marketplace.app.onePasswordTagline": "Inicia sesión en sitios con las credenciales que compartes",
  "marketplace.app.onePasswordCategory": "Gestión de inicios de sesión y credenciales",
  "marketplace.app.yourApps": "Tus apps",
  "marketplace.app.moreApps": "Más apps",
  "marketplace.app.server": "Servidor",
  "marketplace.app.command": "Comando",
  "marketplace.app.address": "Dirección",
  "marketplace.app.disconnect.title": "Desconectar",
  "marketplace.app.disconnect.description":
    "Elimina {name} y sus habilidades de este equipo. Puedes volver a conectarla más adelante.",
  "marketplace.app.disconnect.descriptionOnHost":
    "Quita {name} y sus habilidades de {host}. Puedes volver a conectarla después.",
  "marketplace.app.disconnect.action": "Desconectar",
  "marketplace.app.remove.title": "Quitar servidor",
  "marketplace.app.remove.description": "Tus agentes ya no podrán usar este servidor. Se eliminarán sus ajustes.",
  "marketplace.app.remove.action": "Quitar",
  "marketplace.app.remove.confirmTitle": "¿Eliminar {name}?",
  "marketplace.app.remove.keep": "Conservar",
  "marketplace.plugin.aave.tagline": "Datos y transacciones de Aave",
  "marketplace.plugin.aave.description":
    "Aave ayuda a los usuarios a explorar los mercados en vivo de Aave V3 y V4, revisar posiciones de wallets y la gobernanza de la DAO, simular operaciones de préstamo y preparar transacciones sin custodia. Cada transacción se devuelve sin firmar: el plugin lee los mercados y escribe la llamada, y la wallet sigue en manos del usuario.",
  "marketplace.plugin.aave.app":
    "Mercados en vivo de V3 y V4, posiciones de wallets, gobernanza de la DAO y transacciones preparadas, mediante un único servidor MCP.",
  "marketplace.plugin.aave.prompt.stablecoinYield":
    "¿Dónde puedo obtener ahora mismo el mayor rendimiento con stablecoins en Aave?",
  "marketplace.plugin.aave.prompt.usdcRates": "¿Qué paga más por USDC ahora mismo, Aave V3 o V4 en Ethereum?",
  "marketplace.plugin.aave.prompt.healthFactor":
    "¿Cuál es el factor de salud de 0x0a42b2f3a0d54157dbd7cc346335a4f1909fc02c y a qué distancia está de la liquidación?",
  "marketplace.plugin.canva.tagline": "Diseños, recursos y exportaciones",
  "marketplace.plugin.canva.description":
    "Canva permite a los usuarios crear y editar diseños con palabras, buscar en su propia biblioteca de diseños, subir y organizar recursos, exportar en el formato que necesita cada canal y dejar comentarios donde está el trabajo. Cada usuario inicia sesión en su propia cuenta de Canva, y el agente puede hacer lo que esa cuenta puede hacer.",
  "marketplace.plugin.canva.app":
    "Creación y edición de diseños, búsqueda en la biblioteca, gestión de recursos y de marca, exportaciones y comentarios, mediante un único servidor MCP.",
  "marketplace.plugin.canva.prompt.recentDesign": "Muéstrame el diseño de Canva que edité más recientemente.",
  "marketplace.plugin.canva.prompt.socialResize":
    "Cambia el tamaño de mi póster de lanzamiento para Instagram y exporta ambos como PNG.",
  "marketplace.plugin.canva.prompt.deckFromNotes":
    "Convierte estas notas de la versión en una presentación de Canva de seis diapositivas.",
  "marketplace.plugin.linear.tagline": "Incidencias y triaje de proyectos",
  "marketplace.plugin.linear.description":
    "Linear permite a los agentes listar las incidencias asignadas, clasificar el backlog, actualizar estados y redactar nuevas incidencias en el espacio de trabajo al que pertenece la cuenta con sesión iniciada. Cada usuario inicia sesión en su propia cuenta de Linear desde el navegador.",
  "marketplace.plugin.linear.app":
    "Búsqueda, triaje, cambios de estado y creación de incidencias, mediante el servidor MCP de Linear con inicio de sesión en el navegador.",
  "marketplace.plugin.linear.prompt.myWeek": "¿Qué tengo asignado esta semana?",
  "marketplace.plugin.linear.prompt.backlog": "Clasifica el backlog: ¿qué está obsoleto, bloqueado o sin responsable?",
  "marketplace.plugin.linear.prompt.newIssue":
    "Crea una incidencia para el fallo en la cola de sincronización con los pasos para reproducirlo.",
  "marketplace.plugin.notion.tagline": "Documentos y base de conocimiento",
  "marketplace.plugin.notion.description":
    "Notion permite a los agentes leer y escribir páginas, buscar en el espacio de trabajo y guardar notas de reuniones y especificaciones donde el equipo ya trabaja. Cada usuario inicia sesión en su propia cuenta de Notion desde el navegador.",
  "marketplace.plugin.notion.app":
    "Búsqueda, lectura y escritura de páginas, y navegación por el espacio de trabajo, mediante el servidor MCP de Notion con inicio de sesión en el navegador.",
  "marketplace.plugin.notion.prompt.findSpec":
    "Busca la especificación de lanzamiento actual y resume las preguntas abiertas.",
  "marketplace.plugin.notion.prompt.meetingNotes":
    "Convierte estos puntos en una nota de reunión estructurada en el espacio de mi equipo.",
  "marketplace.plugin.notion.prompt.updateDoc":
    "Actualiza el documento de incorporación con la nueva lista de comprobación de versiones.",
  "marketplace.plugin.cobrain.tagline": "Memoria compartida para tus agentes de IA",
  "marketplace.plugin.cobrain.description":
    "Cobrain es una memoria en Markdown que toda IA que conectes puede leer y escribir. Los agentes cargan el contexto de un cliente o proyecto antes de trabajar, buscan notas y decisiones anteriores y guardan lo que aprenden para que la siguiente conversación empiece donde terminó la anterior. Cada usuario inicia sesión en su propia cuenta de Cobrain.",
  "marketplace.plugin.cobrain.app":
    "Lectura, búsqueda y escritura de notas en tu cerebro de Cobrain, mediante un servidor MCP.",
  "marketplace.plugin.cobrain.prompt.startSession": "Carga mi contexto de Cobrain para este proyecto antes de empezar.",
  "marketplace.plugin.cobrain.prompt.searchDecision":
    "Busca en mis notas de Cobrain lo que decidimos sobre los precios.",
  "marketplace.plugin.cobrain.prompt.saveNote": "Guarda una nota en Cobrain con lo que hicimos hoy y lo que falta.",
  "marketplace.plugin.figma.tagline": "Diseños y prototipos",
  "marketplace.plugin.figma.description":
    "Figma permite a los agentes leer archivos de diseño, inspeccionar componentes, estilos y variables, y entregar especificaciones de producción a los ingenieros. Se conecta al servidor MCP de la aplicación de escritorio de Figma, en este equipo. El servidor solo puede leer diseños; la escritura está en desarrollo.",
  "marketplace.plugin.figma.app":
    "Contexto de diseño, metadatos, variables y capturas de pantalla, mediante el servidor MCP de la aplicación de escritorio de Figma. Por ahora, solo lectura.",
  "marketplace.plugin.figma.prompt.handoff":
    "Prepara la entrega del archivo de pago: lista las pantallas, los componentes y los estilos.",
  "marketplace.plugin.figma.prompt.audit": "Revisa este archivo en busca de espaciados y usos de color incoherentes.",
  "marketplace.plugin.figma.prompt.assets": "Extrae los iconos de marketing a 2x para el paquete de la aplicación.",
  "marketplace.plugin.paper.tagline": "Lienzo de diseño basado en HTML y CSS",
  "marketplace.plugin.paper.description":
    "Paper permite a los agentes leer y escribir el archivo de diseño abierto en Paper Desktop: inspeccionar mesas de trabajo, selecciones, estilos calculados, JSX y tokens, y crear o cambiar marcos, texto y estilos. Instala Paper Desktop, ábrelo una vez y abre un archivo antes de empezar. Atelier inicia la CLI de Paper que instala Paper Desktop. Paper no necesita clave. Las herramientas de escritura cambian el archivo abierto, así que revisa cada escritura antes de aprobarla.",
  "marketplace.plugin.paper.app":
    "Lee y escribe el archivo abierto de Paper Desktop, mediante el servidor MCP local que retransmite la CLI de Paper. Necesita Paper Desktop con un archivo abierto.",
  "marketplace.plugin.paper.prompt.implement":
    "Implementa el marco seleccionado de Paper en este código, con nuestras convenciones de código.",
  "marketplace.plugin.paper.prompt.codeToDesign":
    "Usa los estilos de este repositorio y diseña una página de ajustes en Paper.",
  "marketplace.plugin.paper.prompt.tokens":
    "Lista los tokens de diseño del archivo abierto de Paper y compáralos con nuestro tema.",
  "marketplace.plugin.appleApps.tagline": "Mail, Calendario y más en tu Mac",
  "marketplace.plugin.appleApps.description":
    "Apple apps permite a los agentes usar Mail, Calendario, Contactos, Recordatorios, Notas, Mensajes y Safari en este Mac. Solo funciona en macOS. Atelier inicia mcp-icloud, un servidor de la comunidad que no es de Apple ni de Atelier. El servidor controla las apps con AppleScript, en este equipo, y no necesita cuenta ni clave. La primera vez que un agente usa una app, macOS pregunta si Atelier puede controlarla. Para cambiarlo después, abre Ajustes del Sistema › Privacidad y seguridad › Automatización. Los agentes pueden enviar correos e iMessages, y cambiar o eliminar eventos, contactos y recordatorios, así que revisa cada escritura antes de aprobarla. Lo que leen las herramientas, como el texto de los correos, va al proveedor del modelo del agente.",
  "marketplace.plugin.appleApps.app":
    "Mail, Calendario, Contactos, Recordatorios, Notas, Mensajes y Safari, mediante el servidor local mcp-icloud. Necesita macOS y acceso de Automatización.",
  "marketplace.plugin.appleApps.prompt.unread": "Resume mis correos no leídos de hoy en Apple Mail.",
  "marketplace.plugin.appleApps.prompt.today": "¿Qué hay en mi Calendario de Apple hoy y mañana?",
  "marketplace.plugin.appleApps.prompt.schedule":
    "Busca el correo más reciente sobre la reunión del proyecto y añade la reunión a mi calendario.",
  "marketplace.plugin.sentry.tagline": "Triaje de errores y fallos",
  "marketplace.plugin.sentry.description":
    "Sentry permite a los agentes buscar errores recientes, inspeccionar trazas de pila y versiones afectadas, y resumir qué se rompió tras un despliegue. Cada usuario inicia sesión en su propia cuenta de Sentry desde el navegador.",
  "marketplace.plugin.sentry.app":
    "Búsqueda de errores, inspección de incidencias y estado de las versiones, mediante el servidor MCP de Sentry con inicio de sesión en el navegador.",
  "marketplace.plugin.sentry.prompt.newErrors": "¿Qué errores nuevos aparecieron desde el despliegue de ayer?",
  "marketplace.plugin.sentry.prompt.topCrash": "Explica el fallo más frecuente del proyecto móvil y su causa probable.",
  "marketplace.plugin.sentry.prompt.releaseHealth":
    "¿Cómo es la estabilidad de la versión actual en comparación con la anterior?",
  "marketplace.plugin.vercel.tagline": "Despliegues, registros de compilación y proyectos",
  "marketplace.plugin.vercel.description":
    "Vercel permite a los agentes listar proyectos y despliegues recientes, leer registros de compilación y de ejecución, y averiguar por qué falló una compilación. Cada usuario inicia sesión en su propia cuenta de Vercel desde el navegador y elige los equipos que pueden usar los agentes. En esos equipos, los agentes tienen los mismos permisos que la cuenta del usuario. También pueden cambiar variables de entorno, dominios, registros DNS y despliegues, y comprar dominios.",
  "marketplace.plugin.vercel.app":
    "Proyectos, despliegues, registros de compilación y de ejecución, mediante el servidor MCP de Vercel con inicio de sesión en el navegador.",
  "marketplace.plugin.vercel.prompt.failedBuild": "¿Por qué falló el último despliegue de producción?",
  "marketplace.plugin.vercel.prompt.recentDeployments": "Lista los despliegues de hoy y su estado.",
  "marketplace.plugin.vercel.prompt.runtimeErrors": "¿Qué rutas tuvieron errores de ejecución en la última hora?",
  "marketplace.plugin.cloudflare.tagline": "Workers, DNS, almacenamiento y registros",
  "marketplace.plugin.cloudflare.description":
    "Cloudflare permite a los agentes listar y gestionar Workers, registros DNS, R2, D1 y KV mediante la API de Cloudflare, consultar los registros de Workers y buscar en la documentación de Cloudflare. Cada usuario inicia sesión en su propia cuenta de Cloudflare desde el navegador. En la página de consentimiento de Cloudflare, elige Read only: con la opción predeterminada, Minimal, los agentes no ven los Workers, los registros ni los registros DNS. Con permisos de escritura, los agentes pueden desplegar y eliminar Workers, cambiar registros DNS y modificar otros ajustes de la cuenta.",
  "marketplace.plugin.cloudflare.app":
    "Workers, DNS, almacenamiento y registros, mediante el servidor MCP de la API de Cloudflare con inicio de sesión en el navegador.",
  "marketplace.plugin.cloudflare.prompt.workers": "¿Qué Workers están desplegados en mi cuenta de Cloudflare?",
  "marketplace.plugin.cloudflare.prompt.errors": "¿Qué Workers de Cloudflare registraron errores en la última hora?",
  "marketplace.plugin.cloudflare.prompt.dns": "Lista los registros DNS de cada zona de mi cuenta de Cloudflare.",
  "marketplace.plugin.supabase.tagline": "Bases de datos, registros y edge functions",
  "marketplace.plugin.supabase.description":
    "Supabase permite a los agentes listar proyectos, ejecutar SQL, leer esquemas de tablas y registros, revisar las recomendaciones de seguridad y rendimiento de los advisors, gestionar edge functions y ramas, y buscar en la documentación de Supabase. Cada usuario inicia sesión en su propia cuenta de Supabase desde el navegador y elige una organización. Los agentes tienen acceso completo: pueden ejecutar SQL que cambia o elimina datos, aplicar migraciones, desplegar edge functions y crear o pausar proyectos.",
  "marketplace.plugin.supabase.app":
    "Bases de datos, registros y edge functions, mediante el servidor MCP de Supabase con inicio de sesión en el navegador.",
  "marketplace.plugin.supabase.prompt.projects": "¿Qué proyectos hay en mi organización de Supabase?",
  "marketplace.plugin.supabase.prompt.tables": "Lista las tablas y columnas de mi base de datos de Supabase.",
  "marketplace.plugin.supabase.prompt.errors": "¿Qué errores registró mi proyecto de Supabase en la última hora?",
  "marketplace.plugin.context7.tagline": "Documentación actual de bibliotecas",
  "marketplace.plugin.context7.description":
    "Context7 obtiene la documentación y las referencias de API actuales de bibliotecas y frameworks, para que las respuestas usen la versión que el proyecto realmente ejecuta. No necesita cuenta ni clave.",
  "marketplace.plugin.context7.app":
    "Consulta de documentación actual de bibliotecas, mediante el servidor MCP de Context7 sin inicio de sesión.",
  "marketplace.plugin.context7.prompt.apiCheck": "¿Cuál es la API actual para listas virtualizadas en este framework?",
  "marketplace.plugin.context7.prompt.migrate": "¿Qué cambió entre la v2 y la v3 de este router?",
  "marketplace.plugin.context7.prompt.example": "Muestra un ejemplo actual de subida de archivos con autenticación.",
  "marketplace.plugin.stripe.tagline": "Revisión de pagos y facturación",
  "marketplace.plugin.stripe.description":
    "Stripe permite a los agentes consultar pagos, clientes y facturas, y redactar enlaces de pago, en la cuenta a la que puede acceder el usuario con sesión iniciada. Cada usuario inicia sesión en su propia cuenta de Stripe desde el navegador.",
  "marketplace.plugin.stripe.app":
    "Consulta de pagos, clientes y facturas, mediante el servidor MCP de Stripe con inicio de sesión en el navegador.",
  "marketplace.plugin.stripe.prompt.payment": "Busca este pago y explica por qué falló.",
  "marketplace.plugin.stripe.prompt.customer": "Resume las facturas de este cliente y su saldo pendiente.",
  "marketplace.plugin.stripe.prompt.link": "Redacta un enlace de pago para el plan Pro a 49 al mes.",
  "marketplace.plugin.posthog.tagline": "Analítica de producto y flags",
  "marketplace.plugin.posthog.description":
    "PostHog permite a los agentes consultar eventos y embudos, inspeccionar feature flags y resumir qué cambió tras una versión. Una clave de API personal de los ajustes del proyecto va en un único encabezado Authorization.",
  "marketplace.plugin.posthog.app":
    "Acceso a eventos, embudos y feature flags, mediante el servidor MCP de PostHog con una clave de API personal.",
  "marketplace.plugin.posthog.prompt.funnel": "¿Cómo se ve el embudo de registro de los últimos 14 días?",
  "marketplace.plugin.posthog.prompt.flag": "¿Qué feature flags están activados para este usuario?",
  "marketplace.plugin.posthog.prompt.release": "¿Cambió la activación después de la versión de la semana pasada?",
  "marketplace.plugin.airtable.tagline": "Bases y registros",
  "marketplace.plugin.airtable.description":
    "Airtable permite a los agentes listar bases, leer y actualizar registros y resumir el contenido de las tablas. Una clave de API de la página de la cuenta se pasa al servidor local como una variable de entorno.",
  "marketplace.plugin.airtable.app":
    "Listado de bases y acceso a registros, mediante un servidor MCP local con una clave de API de Airtable.",
  "marketplace.plugin.airtable.prompt.bases": "¿A qué bases tengo acceso?",
  "marketplace.plugin.airtable.prompt.records": "Resume la tabla de seguimiento del lanzamiento.",
  "marketplace.plugin.airtable.prompt.update":
    "Marca como terminadas las funciones publicadas en la base de la hoja de ruta.",
  "marketplace.plugin.firecrawl.tagline": "Extracción y búsqueda web",
  "marketplace.plugin.firecrawl.description":
    "Firecrawl permite a los agentes extraer el contenido de páginas, obtener datos estructurados y buscar en la web con una única API. Una clave de API del panel de Firecrawl se pasa al servidor local como una variable de entorno.",
  "marketplace.plugin.firecrawl.app":
    "Extracción de páginas y datos, y búsqueda web, mediante un servidor MCP local con una clave de API de Firecrawl.",
  "marketplace.plugin.firecrawl.prompt.scrape": "Extrae la tabla de precios de esta página como datos estructurados.",
  "marketplace.plugin.firecrawl.prompt.research":
    "Investiga los precios de la competencia y cita cada página de origen.",
  "marketplace.plugin.firecrawl.prompt.monitor": "¿Qué cambió en nuestra página de cambios este mes?",
  "marketplace.plugin.braveSearch.tagline": "Búsqueda web privada",
  "marketplace.plugin.braveSearch.description":
    "Brave Search permite a los agentes buscar en la web y obtener resultados locales sin rastreo. Una clave de API del panel de Brave Search API se pasa al servidor local como una variable de entorno.",
  "marketplace.plugin.braveSearch.app":
    "Búsqueda web y local, mediante un servidor MCP local con una clave de API de Brave.",
  "marketplace.plugin.braveSearch.prompt.search": "¿Qué dicen las reseñas sobre esta versión del framework?",
  "marketplace.plugin.braveSearch.prompt.news": "Busca los anuncios de hoy sobre esta área de producto.",
  "marketplace.plugin.braveSearch.prompt.compare": "Compara estos dos proveedores con fuentes citadas.",
  "marketplace.plugin.resend.tagline": "Correo transaccional",
  "marketplace.plugin.resend.description":
    "Resend permite a los agentes enviar correo transaccional y comprobar la entrega con una única API. Una clave de API del panel de Resend se pasa al servidor local como una variable de entorno.",
  "marketplace.plugin.resend.app":
    "Envío de correo y comprobación de entrega, mediante un servidor MCP local con una clave de API de Resend.",
  "marketplace.plugin.resend.prompt.send": "Envía el borrador del anuncio de lanzamiento a la lista beta.",
  "marketplace.plugin.resend.prompt.status": "¿Llegó al cliente el correo de la factura?",
  "marketplace.plugin.resend.prompt.template":
    "Redacta un correo de restablecimiento de contraseña para el nuevo flujo.",
  "marketplace.plugin.composio.tagline": "Muchas aplicaciones con tu propio enlace de Composio",
  "marketplace.plugin.composio.description":
    "Composio conecta los agentes con Gmail, Slack, GitHub y cientos de aplicaciones más mediante un único servidor MCP. Conecta las aplicaciones que quieras en tu cuenta de Composio y pega aquí su URL de MCP y su clave de API.",
  "marketplace.plugin.composio.app":
    "Las aplicaciones que añadas a tu servidor MCP de Composio, mediante el enlace de tu cuenta de Composio.",
  "marketplace.plugin.composio.prompt.inbox": "Resume mi correo no leído y redacta respuestas a los urgentes.",
  "marketplace.plugin.composio.prompt.handoff":
    "Publica un resumen de este pull request en el canal de nuestro equipo.",
  "marketplace.plugin.composio.prompt.apps": "¿Qué aplicaciones y acciones puedes usar mediante Composio?",
  "marketplace.plugin.composio.hint.url": "La URL de un servidor MCP en tu cuenta de Composio",
  "marketplace.plugin.composio.hint.apiKey":
    "La encontrarás en tu cuenta de Composio, en Settings > Sessions & API Key.",
  "marketplace.auth.apiKey": "Clave de API",
  "marketplace.auth.personalApiKey": "Clave de API personal",
  "marketplace.auth.mcpUrl": "URL de MCP",
  "marketplace.auth.createKey": "Crear una clave",
  "marketplace.skill.installMenu.install": "Instalar",
  "marketplace.skill.installMenu.installNamed": "Instalar {name}",
  "marketplace.skill.installMenu.allAgents": "Todos los agentes",
  "marketplace.skill.installMenu.agents": {
    one: "{count} agente",
    other: "{count} agentes",
  },
  "marketplace.skill.installMenu.here": "Estás aquí",
  "marketplace.skill.installMenu.change": {
    one: "{label} tiene {name}. Cambiar",
    other: "{label} tienen {name}. Cambiar",
  },
  "marketplace.skill.doc": "SKILL.md",
  "marketplace.try.in": "Probar en {name}",
  "marketplace.notice.agentAdded": "{name} añadido.",
  "marketplace.notice.agentUpdated": "{name} actualizado.",
  "marketplace.notice.appConnected": "{name} conectada.",
  "marketplace.notice.appDisconnected": "{name} desconectada.",
  "marketplace.notice.serverRemoved": "{name} eliminado.",
  "marketplace.notice.skillsUpdated": {
    one: "{count} habilidad actualizada.",
    other: "{count} habilidades actualizadas.",
  },
  "marketplace.notice.accountEnabled": "{name} activada.",
  "marketplace.notice.accountDisabled": "{name} desactivada.",
  "marketplace.notice.accountRenamed": "Nuevo nombre: {name}.",
  "marketplace.notice.accountChecked": {
    one: "{name} funciona. Hay {count} herramienta disponible.",
    other: "{name} funciona. Hay {count} herramientas disponibles.",
  },
  "marketplace.notice.accountCheckFailed": "{name} no funciona.",
  "marketplace.notice.accountReconnected": "{name} está conectada de nuevo.",
  "marketplace.notice.appUpdated": {
    one: "{count} cuenta de {name} actualizada.",
    other: "{count} cuentas de {name} actualizadas.",
  },
  "marketplace.notice.appUpdatedSignIn": {
    one: "{count} cuenta de {name} actualizada. Vuelve a iniciar sesión si la app lo pide.",
    other: "{count} cuentas de {name} actualizadas. Vuelve a iniciar sesión si la app lo pide.",
  },
  "marketplace.notice.accessSet": "{account} para {agent}: {mode}.",
  "marketplace.notice.skillInstalled": {
    one: "{name} instalada en {count} agente.",
    other: "{name} instalada en {count} agentes.",
  },
  "marketplace.notice.skillRemoved": {
    one: "{name} eliminada de {count} agente.",
    other: "{name} eliminada de {count} agentes.",
  },
  "marketplace.error.skillPartial": "{name} no cambió en estos agentes: {agents}. {reason}",
  "marketplace.tab.eventChecks": "Comprobaciones de eventos",
  "marketplace.loading.eventChecks": "Cargando comprobaciones de eventos",
  "marketplace.noMatch.eventChecks": "Ninguna comprobación de eventos coincide con esta búsqueda.",
  "marketplace.noMatch.showEventChecks": {
    one: "Mostrar {count} comprobación de eventos",
    other: "Mostrar {count} comprobaciones de eventos",
  },
  "marketplace.empty.eventChecks": "Todavía no hay comprobaciones de eventos en el marketplace.",
  "marketplace.properties.eventCheck": "Acerca de esta comprobación de eventos",
  "marketplace.properties.worksWith": "Funciona con",
  "marketplace.properties.website": "Sitio web",
  "marketplace.properties.interval": "Intervalo predeterminado",
  "marketplace.eventCheck.intro":
    "Una comprobación de eventos lee una app según un horario, sin IA, y despierta a un agente solo cuando hay algo nuevo o cambiado.",
  "marketplace.eventCheck.worksWith": "Funciona con {app}",
  "marketplace.eventCheck.installed": "Instalada",
  "marketplace.eventCheck.updateAvailable": "Actualización disponible",
  "marketplace.eventCheck.install": "Instalar",
  "marketplace.eventCheck.loading": "Cargando comprobaciones de eventos",
  "marketplace.eventCheck.loadFailed": "No se pudieron cargar las comprobaciones de eventos de este host.",
  "marketplace.eventCheck.missing": "Esta comprobación de eventos no está en este host.",
  "marketplace.eventCheck.intervalSeconds": { one: "{count} segundo", other: "{count} segundos" },
  "marketplace.eventCheck.need.title": "Lo que necesitas",
  "marketplace.eventCheck.need.variables": "Variables privadas",
  "marketplace.eventCheck.need.variablesHelp":
    "Las escribes después de instalar, en campos ocultos. Se quedan en el host y nunca se envían a un chat.",
  "marketplace.eventCheck.need.docs": "Guía de configuración",
  "marketplace.eventCheck.need.docsNamed": "Guía de configuración de {label}",
  "marketplace.eventCheck.need.settings": "Ajustes",
  "marketplace.eventCheck.need.settingsHelp": "Puedes cambiarlos al instalar.",
  "marketplace.eventCheck.need.required": "Obligatorio",
  "marketplace.eventCheck.optional": "Opcional",
  "marketplace.eventCheck.dialog.draftTitle": "Para cargar tu lista",
  "marketplace.eventCheck.dialog.draftHelp":
    "Estos valores privados se usan una vez para leer tu lista. Se guardan para la comprobación cuando presionas Listo en el siguiente paso.",
  "marketplace.eventCheck.need.nothing": "Esta comprobación de eventos no necesita variables privadas ni ajustes.",
  "marketplace.eventCheck.need.interval": "Revisa cada {interval} de forma predeterminada.",
  "marketplace.eventCheck.forApp": "Comprobaciones de eventos para esta app",
  "marketplace.eventCheck.forAppHelp":
    "Comprobaciones revisadas que leen la API de esta app. Usan sus propias variables privadas, nunca las cuentas que conectaste aquí.",
  "marketplace.eventCheck.view": "Ver",
  "marketplace.eventCheck.installedTitle": "Instaladas",
  "marketplace.eventCheck.installedHelp": "Cada copia de esta comprobación de eventos, en todos los agentes.",
  "marketplace.eventCheck.installedNone": "Todavía no está instalada en ningún agente.",
  "marketplace.eventCheck.reading": "Leyendo las comprobaciones de eventos de tus agentes",
  "marketplace.eventCheck.readFailed": "No se pudieron leer las comprobaciones de eventos de {agents}.",
  "marketplace.eventCheck.instance": "{agent} · {account}",
  "marketplace.eventCheck.status.paused": "En pausa",
  "marketplace.eventCheck.status.active": "Activa",
  "marketplace.eventCheck.version": "Versión {version}",
  "marketplace.eventCheck.update": "Actualizar",
  "marketplace.eventCheck.updateNamed": "Actualizar {name}",
  "marketplace.eventCheck.update.title": "¿Actualizar {name}?",
  "marketplace.eventCheck.update.description":
    "Esto pasa la comprobación de la versión {from} a la versión {to}. Tus ajustes, horario e instrucción se conservan. La comprobación recibe una línea base nueva: guarda lo que la app muestra ahora y no avisa hasta que algo cambie.",
  "marketplace.eventCheck.update.confirm": "Actualizar y reiniciar la línea base",
  "marketplace.eventCheck.updated": "{name} está en la versión {version}. Tiene una línea base nueva.",
  "marketplace.eventCheck.unlinked.title": "Comprobaciones de eventos que hiciste tú",
  "marketplace.eventCheck.unlinked.help":
    "Estas comprobaciones no tienen plantilla. Si una ejecuta exactamente el programa de esta plantilla, puedes vincularla. La línea base se conserva.",
  "marketplace.eventCheck.link": "Vincular a esta plantilla",
  "marketplace.eventCheck.linkNamed": "Vincular {name} a esta plantilla",
  "marketplace.eventCheck.linked": "{name} está vinculada a esta plantilla.",
  "marketplace.eventCheck.dialog.title": "Instalar {name}",
  "marketplace.eventCheck.dialog.description":
    "Esto crea una comprobación de eventos en pausa para cada agente que elijas. No se ejecuta nada hasta que pruebes la comprobación y la actives.",
  "marketplace.eventCheck.dialog.agents": "Agentes",
  "marketplace.eventCheck.dialog.noAgents": "No tienes ningún agente en el que instalar esta comprobación de eventos.",
  "marketplace.eventCheck.dialog.agentsRequired": "Elige al menos un agente.",
  "marketplace.eventCheck.dialog.accountLabel": "Etiqueta de la cuenta",
  "marketplace.eventCheck.dialog.accountLabelHelp":
    "Distingue las cuentas cuando instalas esta comprobación de eventos más de una vez.",
  "marketplace.eventCheck.dialog.fieldRequired": "Este campo es obligatorio.",
  "marketplace.eventCheck.dialog.intervalInvalid": "Escribe al menos 30 segundos.",
  "marketplace.eventCheck.dialog.actorIdsTooMany": "Escribe máximo {max} ID.",
  "marketplace.eventCheck.dialog.actorIds": "Tus ID de usuario verificados",
  "marketplace.eventCheck.dialog.actorIdsHelp":
    "Tus propios ID de usuario en la app, separados por comas o saltos de línea. La comprobación omite los cambios que hicieron estos ID. Necesitas al menos un ID para activar la comprobación. Puedes dejarlo vacío mientras esté en pausa.",
  "marketplace.eventCheck.dialog.submit": { one: "Instalar en {count} agente", other: "Instalar en {count} agentes" },
  "marketplace.eventCheck.dialog.installing": "Instalando…",
  "marketplace.eventCheck.dialog.done.title": "Agrega las variables privadas",
  "marketplace.eventCheck.dialog.done.paused":
    "Las comprobaciones se crearon en pausa. Escribe las variables privadas abajo y presiona Listo para guardarlas. Luego prueba cada comprobación y actívala en los ajustes del agente, Comprobaciones de eventos.",
  "marketplace.eventCheck.dialog.done.noVariables":
    "Las comprobaciones se crearon en pausa. Esta comprobación de eventos no necesita variables privadas. Prueba cada comprobación y actívala en los ajustes del agente, Comprobaciones de eventos.",
  "marketplace.eventCheck.dialog.done.check": "{agent} · {name}",
  "marketplace.eventCheck.dialog.failedTitle": "No se pudo instalar en algunos agentes",
  "marketplace.eventCheck.dialog.failedFor": "{agent}: {reason}",
  "marketplace.eventCheck.dialog.valuesFailedTitle": "No se pudieron guardar algunos valores privados",
  "marketplace.eventCheck.dialog.discardValues":
    "Las comprobaciones se conservan, pero los valores privados que escribiste no se guardarán.",
  "marketplace.eventCheck.dialog.retryFailed": "Reintentar los agentes que fallaron",
  "marketplace.eventCheck.dialog.finish": "Listo",
  "marketplace.error.openLink": "No se pudo abrir el enlace.",
  "marketplace.error.accountNoServer":
    "Esta cuenta no puede cambiar las cuentas de apps de este servidor. Pídeselo a un dueño o administrador.",
  "marketplace.error.updateFailed": "{name} no se actualizó porque la nueva versión no funcionó. {reason}",
  "marketplace.error.updateAllPartial": "No se pudo actualizar {skills}.",
  "marketplace.error.accessGone":
    "{name} no está disponible para los chats ahora. Cierra esta ventana e intenta de nuevo.",
  "marketplace.error.copyLink": "No se pudo copiar el enlace.",
  "marketplace.error.connectNoServer": "Selecciona un servidor local para conectar esta app.",
  "marketplace.error.installNoServer": "Selecciona un servidor local para instalar un plugin.",
  "marketplace.error.installNoAgent": "Elige un agente para instalar las habilidades de este plugin.",
  "marketplace.error.installLocalOnHost":
    "Instala {name} en el equipo donde se ejecutan estos agentes: su app ejecuta su servidor en ese equipo.",
  "marketplace.error.installOnHost":
    "Instala {name} en el equipo donde se ejecutan estos agentes: su app requiere iniciar sesión en un navegador.",
  "marketplace.error.appInvalid": "No se puede añadir {name}: {reason}",
  "marketplace.error.uninstallNoServer": "Selecciona un servidor local para desinstalar un plugin.",
  "marketplace.error.uninstallPartial": "No se pudieron eliminar algunas partes de {name}. {failures}",
  "marketplace.error.actionFailed": "No se pudo completar la acción del marketplace. Inténtalo de nuevo.",
  "marketplace.thisAgent": "este agente",
  "marketplace.account.disabled": "Desactivada",
  "marketplace.account.outdated": "Actualización disponible",
  "marketplace.account.rename": "Cambiar nombre",
  "marketplace.account.renameNamed": "Cambiar el nombre de {name}",
  "marketplace.account.check": "Comprobar conexión",
  "marketplace.account.checkNamed": "Comprobar la conexión de {name}",
  "marketplace.account.checking": "Comprobando…",
  "marketplace.account.working": {
    one: "Funciona. Hay {count} herramienta disponible.",
    other: "Funciona. Hay {count} herramientas disponibles.",
  },
  "marketplace.account.failed": "No funciona. {reason}",
  "marketplace.account.removeDescription": "{name} se quita de {host}. La app y sus otras cuentas se conservan.",
  "marketplace.account.removeChats": "Los chats de {agents} ya no podrán usarla.",
  "marketplace.account.removeChatsNone": "Ningún chat puede usarla ahora.",
  "marketplace.account.removeChatsUnknown": "Los chats ya no podrán usarla.",
  "marketplace.account.removeSignIn":
    "Se borra el inicio de sesión o la clave guardada. Vuelve a conectar para usar la cuenta.",
  "marketplace.account.signedOut": "Sesión cerrada. Vuelve a iniciar sesión para usar esta cuenta.",
  "marketplace.account.signedOutTitle": "Vuelve a iniciar sesión en {name}",
  "marketplace.account.signedOutDescription":
    "Este computador ya no tiene el inicio de sesión, así que los agentes no pueden usar esta cuenta hasta que vuelvas a iniciar sesión.",
  "marketplace.account.signIn": "Volver a iniciar sesión",
  "marketplace.account.signInNamed": "Volver a iniciar sesión en {name}",
  "marketplace.account.changeKey": "Cambiar clave",
  "marketplace.account.changeKeyNamed": "Cambiar la clave de {name}",
  "marketplace.account.updateTitle": "Actualizar {name}",
  "marketplace.account.updateDescription": {
    one: "Una cuenta de {name} todavía usa una versión anterior de su servidor. La actualización la pasa a la versión actual. Su nombre, inicio de sesión y acceso a chats se conservan.",
    other:
      "{count} cuentas de {name} todavía usan una versión anterior de su servidor. La actualización las pasa a la versión actual. Sus nombres, inicios de sesión y accesos a chats se conservan.",
  },
  "marketplace.account.update": "Actualizar",
  "marketplace.account.updateNamed": "Actualizar la conexión de {name}",
  "marketplace.access.title": "Acceso de los chats",
  "marketplace.access.description":
    "Elige qué puede hacer el chat de cada agente con cada cuenta. Una cuenta nueva empieza Desactivada en todos los chats.",
  "marketplace.access.thisChat": "Este chat",
  "marketplace.access.loading": "Leyendo el acceso de los chats",
  "marketplace.access.readFailed": "No se pudo leer el acceso de los chats de {agents}.",
  "marketplace.access.saving":
    "Guardando el acceso de {agent}. El host actualiza sus agentes, así que puede tardar un momento.",
  "marketplace.access.unreadable": "No disponible",
  "marketplace.access.noAccounts": "Activa una cuenta para elegir qué pueden hacer los chats con ella.",
  "marketplace.access.disabledNote": "Una cuenta desactivada no se ofrece a ningún chat.",
  "marketplace.access.groups": "Los chats de grupo se configuran en el propio chat, en Apps de este chat.",
  "marketplace.access.groupLabel": "{agent}, {account}",
  "marketplace.access.allowFor": "Permitir para {agent}",
  "marketplace.access.allowDescription":
    "{account} está conectada, pero {agent} todavía no puede usarla. Elige qué puede hacer {agent} con ella.",
  "marketplace.access.notNow": "Dejarla desactivada",
} as const satisfies PartialTranslation<typeof source>;

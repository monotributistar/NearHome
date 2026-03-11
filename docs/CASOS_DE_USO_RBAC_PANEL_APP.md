# Casos de Uso: RBAC, Multi-Tenant, Panel y App Cliente

## 1. Objetivo
Definir casos de uso funcionales para:
- Superadministrador global (visibilidad total).
- Administradores con control total del tenant.
- Operadores/monitores con visibilidad por defecto global y zonificación posterior.
- Usuarios cliente/customer en app móvil/web.

El documento cubre:
- Modelo de acceso y asociaciones N:M.
- Flujos operativos en panel de control.
- Flujos de cliente (login, suscripción, comprobante, domicilios, cámaras, notificaciones realtime).

## 2. Modelo de Actores y Acceso

## 2.1 Actores
- `super_admin`: ve y administra todo el sistema (todos los tenants, nodos, cámaras, usuarios, membresías, planes, canales).
- `tenant_admin`: administra su tenant (usuarios, operadores, cámaras, perfiles, suscripción, notificaciones).
- `operator` (monitor): opera monitoreo y respuesta de incidentes.
- `customer`: usuario final del tenant (hogar/empresa) que consume la app.

## 2.2 Reglas de asociación
- Operadores ↔ Tenants: relación N:M.
- Customers ↔ Tenants: relación N:M.
- Cada tenant puede tener múltiples operadores y múltiples customers.
- Un operador puede estar en múltiples tenants.
- Un customer puede estar en múltiples tenants (ej: múltiples domicilios/empresas).

## 2.3 Política solicitada (objetivo)
- Por defecto, operadores/monitores pueden ver todos los tenants.
- Luego se puede "zonificar" para limitar su alcance a subconjuntos (tenants, ubicaciones, cámaras, zonas).
- `super_admin` puede cambiar entre contextos/roles desde panel (impersonación controlada).

## 2.4 Estado actual vs objetivo
- Estado actual implementado: membership por tenant + rol tenant-scoped.
- Objetivo de este documento: extender a visibilidad global por defecto de operadores + zonificación configurable.

## 3. Matriz de Capacidades por Rol (Objetivo)
| Capacidad | super_admin | tenant_admin | operator | customer |
|---|---:|---:|---:|---:|
| Ver todos los tenants | Si | No | Si (por defecto) | No |
| Zonificar operador/customer | Si | Si (en su tenant) | No | No |
| Crear/editar tenants | Si | No | No | No |
| Crear/editar usuarios y memberships | Si | Si (tenant) | No | No |
| Cambiar rol de usuario | Si | Si (tenant, con límites) | No | No |
| Impersonar rol/usuario | Si | No | No | No |
| Alta/edición de cámaras | Si | Si | Opcional (según policy) | Si (en su contexto de hogar) |
| Ver monitor realtime | Si | Si | Si | Si (cámaras propias) |
| Configurar reglas/notificaciones | Si | Si | No | Preferencias personales |
| Gestionar suscripción tenant | Si | Si | No | Solicitar/cargar comprobante |

## 4. Casos de Uso del Panel de Control

## UC-PANEL-01: Login de usuario administrativo
- Actor: `super_admin`, `tenant_admin`, `operator`.
- Precondiciones: usuario activo, credenciales válidas.
- Flujo principal:
1. Ingresa email/password.
2. Sistema valida y devuelve sesión/token.
3. Se carga contexto de tenants y rol(es).
- Alternativos:
1. Credenciales inválidas.
2. Usuario desactivado.
- Postcondición: sesión activa y navegación al dashboard.

## UC-PANEL-02: Superadmin gestiona tenants globalmente
- Actor: `super_admin`.
- Flujo principal:
1. Lista todos los tenants.
2. Crea/edita/desactiva tenant.
3. Asigna planes/suscripciones.
- Postcondición: tenant actualizado y auditado.

## UC-PANEL-03: Alta de operador con asociación N:M a tenants
- Actor: `super_admin`, `tenant_admin`.
- Flujo principal:
1. Crear usuario operador.
2. Asociar uno o más tenants.
3. Definir alcance inicial (global por defecto o acotado).
- Alternativos:
1. Email existente.
2. Tenant inválido.
- Postcondición: operador activo con memberships N:M.

## UC-PANEL-04: Zonificación de operador
- Actor: `super_admin`, `tenant_admin`.
- Objetivo: limitar visibilidad por tenant/sede/cámara/zona.
- Flujo principal:
1. Seleccionar operador.
2. Definir alcance (tenant list + filtros por ubicación/zona/cámara).
3. Guardar política.
- Postcondición: operador ve solo el alcance definido.

## UC-PANEL-05: Alta de customer y asociación N:M a tenants
- Actor: `super_admin`, `tenant_admin`.
- Flujo principal:
1. Crear customer.
2. Asociar tenant(es).
3. Asignar domicilios/casas permitidas.
- Postcondición: customer habilitado para app con alcance correcto.

## UC-PANEL-06: Cambio de rol por superadmin
- Actor: `super_admin`.
- Flujo principal:
1. Seleccionar usuario.
2. Cambiar rol (`tenant_admin`/`operator`/`customer`).
3. Ajustar memberships y alcances.
- Postcondición: permisos efectivos actualizados.

## UC-PANEL-07: Impersonación (switch de contexto)
- Actor: `super_admin`.
- Flujo principal:
1. Selecciona tenant/rol objetivo.
2. Navega panel como ese contexto.
3. Finaliza impersonación.
- Reglas:
1. Toda acción queda auditada con actor real + contexto impersonado.

## UC-PANEL-08: Gestión de nodos de detección por tenant
- Actor: `super_admin`, `tenant_admin`.
- Flujo principal:
1. Ver nodos y estado.
2. Asignar un nodo a uno o varios tenants.
3. Ajustar capacidades/modelos y drenar/revocar.
- Postcondición: routing de detección respetando tenant + capacidades.

## UC-PANEL-09: Configuración de reglas por cámara
- Actor: `tenant_admin`.
- Flujo principal:
1. Abrir perfil interno de cámara.
2. Configurar `detectorFlags`, `rulesProfile.notification`.
3. Guardar.
- Postcondición: pipeline de incidentes y notificaciones ajustado.

## UC-PANEL-10: Gestión de canales de notificación
- Actor: `tenant_admin`.
- Flujo principal:
1. Crear canal webhook/email.
2. Activar/desactivar canal.
3. Revisar entregas en historial.
- Postcondición: notificaciones operativas por tenant.

## 5. Casos de Uso App Cliente

## UC-APP-01: Login customer
- Actor: `customer`.
- Flujo principal:
1. Ingresa credenciales.
2. Selecciona tenant/contexto si tiene múltiples.
3. Accede a inicio.

## UC-APP-02: Alta de domicilio/casa
- Actor: `customer`.
- Flujo principal:
1. Crea domicilio (nombre, dirección, metadata).
2. Define tipo (hogar/oficina/sucursal).
3. Guarda.
- Postcondición: domicilio disponible para cámaras/miembros.

## UC-APP-03: Alta de miembros (familia/empleados)
- Actor: `customer`.
- Flujo principal:
1. Agrega miembros con rol local (familiar, empleado, invitado).
2. Asocia a domicilio(s).
3. Define permisos (ver cámaras/recibir alertas).

## UC-APP-04: Alta de cámara por URL RTSP (y RTCP roadmap)
- Actor: `customer`, `tenant_admin`.
- Flujo principal:
1. Ingresa nombre, ubicación, URL RTSP, credenciales.
2. Asocia cámara a domicilio.
3. Ejecuta validación y health.
- Alternativos:
1. Cámara no accesible.
2. Credenciales inválidas.
- Postcondición: cámara en estado `ready` o `degraded/offline` con diagnóstico.

## UC-APP-05: Ver cámaras en realtime
- Actor: `customer`, `operator`, `tenant_admin`.
- Flujo principal:
1. Abrir monitor.
2. Filtrar por domicilio/cámara.
3. Ver feed y estado health.

## UC-APP-06: Recibir notificaciones en tiempo real
- Actor: `customer`, `operator`.
- Flujo principal:
1. Se detecta incidente.
2. Sistema evalúa regla por cámara/tenant.
3. Notifica vía realtime/webhook/email según configuración.

## UC-APP-07: Solicitar suscripción
- Actor: `customer`.
- Flujo principal:
1. Selecciona plan.
2. Envía solicitud de alta/cambio.
3. Queda pendiente de validación administrativa.

## UC-APP-08: Enviar comprobante de depósito (imagen)
- Actor: `customer`.
- Flujo principal:
1. Carga imagen comprobante.
2. Completa referencia (monto, fecha, banco, observaciones).
3. Envía para revisión.
- Postcondición: caso de facturación en estado `pending_review`.

## 6. Reglas de autorización requeridas
- `super_admin`:
  - acceso global, impersonación, cambio de roles, tenant CRUD global.
- `tenant_admin`:
  - gestiona users/operators/customers y memberships en su tenant.
  - puede configurar cámaras, nodos asignados al tenant, reglas y canales.
- `operator`:
  - monitoreo/operación; acceso global por defecto con zonificación posterior.
- `customer`:
  - gestiona domicilios, miembros, cámaras propias, preferencias de alerta, suscripción y comprobantes.

## 7. Criterios de aceptación mínimos
1. Existe al menos un `super_admin` con visibilidad global y switch de contexto.
2. Operadores pueden asociarse N:M a tenants.
3. Customers pueden asociarse N:M a tenants.
4. Zonificación configurable por operador/customer.
5. Panel permite CRUD de users/memberships/cámaras/reglas/canales por rol.
6. App cliente permite login, domicilios, miembros, alta de cámara RTSP, monitor realtime.
7. App cliente permite solicitud de suscripción + carga de comprobante imagen.
8. Notificaciones realtime operativas y auditables.

## 8. Trazabilidad sugerida a backlog
- RBAC global + impersonación.
- Operador global por defecto + zonificación.
- Customer app: domicilios, miembros, cámaras, suscripción, comprobante.
- Motor de notificaciones realtime + canales + entregas.

# Historias de Usuario + Gherkin (RBAC, Tenants, Panel y App)

Base funcional: `docs/CASOS_DE_USO_RBAC_PANEL_APP.md`

## 1. Alcance
Este documento traduce los casos de uso a historias de usuario implementables y testeables.

## 2. Historias de Usuario Priorizadas

## Epic A - Identidad y RBAC Global

### US-001 - Login administrativo
Como usuario administrativo (`super_admin`, `tenant_admin`, `operator`)
quiero autenticarme en el panel
para operar según mi rol.

Criterios (Gherkin):
```gherkin
Feature: Login administrativo

  Scenario: Login exitoso con credenciales válidas
    Given un usuario administrativo activo con credenciales válidas
    When envía email y password al endpoint de login
    Then el sistema responde con token de sesión válido
    And el frontend redirige al dashboard

  Scenario: Login fallido por credenciales inválidas
    Given un usuario con credenciales inválidas
    When intenta iniciar sesión
    Then el sistema responde 401
    And muestra un mensaje de error legible
```

### US-002 - Superadmin con visibilidad total
Como `super_admin`
quiero ver y administrar todos los tenants
para operar globalmente sin restricciones de tenant.

Criterios (Gherkin):
```gherkin
Feature: Visibilidad global del superadmin

  Scenario: Listado global de tenants
    Given un usuario con rol super_admin autenticado
    When consulta el listado de tenants
    Then obtiene todos los tenants activos del sistema

  Scenario: Operación global sobre tenant
    Given un usuario con rol super_admin autenticado
    And existe un tenant objetivo
    When actualiza la configuración del tenant
    Then la actualización se persiste
    And se registra auditoría con actor y timestamp
```

### US-003 - Cambio de rol por superadmin
Como `super_admin`
quiero cambiar el rol de un usuario
para administrar su capacidad operativa.

Criterios (Gherkin):
```gherkin
Feature: Cambio de rol

  Scenario: Cambio de rol exitoso
    Given un super_admin autenticado
    And existe un usuario destino
    When cambia su rol a operator
    Then el sistema persiste el nuevo rol
    And la próxima sesión aplica permisos de operator

  Scenario: Cambio de rol no permitido por actor no autorizado
    Given un tenant_admin autenticado
    When intenta cambiar el rol de un usuario fuera de su tenant
    Then el sistema responde 403
```

### US-004 - Impersonación de contexto
Como `super_admin`
quiero cambiar de contexto (tenant/rol)
para auditar o asistir operaciones.

Criterios (Gherkin):
```gherkin
Feature: Impersonación

  Scenario: Impersonación iniciada por superadmin
    Given un super_admin autenticado
    And existe un tenant destino
    When inicia impersonación como tenant_admin del tenant destino
    Then la UI refleja el contexto impersonado
    And cada acción guarda actor real y contexto impersonado en auditoría

  Scenario: Actor no autorizado intenta impersonar
    Given un operator autenticado
    When intenta iniciar impersonación
    Then el sistema responde 403
```

## Epic B - Multi-tenant y Membresías N:M

### US-005 - Asignar operador a múltiples tenants
Como `super_admin` o `tenant_admin`
quiero asignar un operador a uno o más tenants
para operar cobertura compartida.

Criterios (Gherkin):
```gherkin
Feature: Membresías N:M para operadores

  Scenario: Asociación múltiple exitosa
    Given un operador existente
    And dos tenants válidos
    When se guardan membresías del operador para ambos tenants
    Then el operador queda asociado a ambos tenants
    And puede visualizar recursos según su política de alcance

  Scenario: Asociación rechazada por tenant inválido
    Given un operador existente
    When se intenta asociar a un tenant inexistente
    Then el sistema responde 404
```

### US-006 - Asignar customer a múltiples tenants
Como `super_admin` o `tenant_admin`
quiero asociar un customer a múltiples tenants
para soportar múltiples domicilios/empresas.

Criterios (Gherkin):
```gherkin
Feature: Membresías N:M para customers

  Scenario: Customer multi-tenant
    Given un customer existente
    And dos tenants habilitados
    When se asocia el customer a ambos tenants
    Then el customer puede seleccionar contexto de tenant en la app

  Scenario: Acceso denegado a tenant no asociado
    Given un customer autenticado asociado a tenant A
    When intenta acceder datos del tenant B no asociado
    Then el sistema responde 403
```

### US-007 - Operador global por defecto y zonificación opcional
Como responsable de operaciones
quiero que operadores vean todo por defecto y luego puedan zonificarse
para iniciar rápido y restringir por política.

Criterios (Gherkin):
```gherkin
Feature: Alcance de operador

  Scenario: Operador sin zonificación
    Given un operador autenticado sin política de zonificación explícita
    When abre monitor
    Then visualiza cámaras de todos los tenants asociados

  Scenario: Operador zonificado
    Given un operador autenticado con política de zonificación por cámaras
    When abre monitor
    Then solo visualiza cámaras incluidas en su política
```

## Epic C - Panel de Control Operativo

### US-008 - CRUD de usuarios y memberships por rol
Como `tenant_admin`
quiero crear y editar usuarios dentro de mi tenant
para administrar el equipo sin depender de superadmin.

Criterios (Gherkin):
```gherkin
Feature: Gestión de usuarios y memberships

  Scenario: Tenant admin crea operador en su tenant
    Given un tenant_admin autenticado
    And un tenant activo propio
    When crea un usuario con rol operator
    Then el usuario queda activo y asociado al tenant

  Scenario: Tenant admin intenta editar usuario fuera de su tenant
    Given un tenant_admin autenticado
    When intenta editar un usuario de otro tenant
    Then el sistema responde 403
```

### US-009 - Configurar cámara desde panel
Como `tenant_admin` o `super_admin`
quiero crear/editar cámaras con URL RTSP y metadata
para habilitar monitoreo e inferencia.

Criterios (Gherkin):
```gherkin
Feature: Gestión de cámaras

  Scenario: Alta de cámara válida
    Given un tenant_admin autenticado
    When registra una cámara con URL RTSP y ubicación válidas
    Then la cámara se guarda en estado provisioning o ready
    And queda visible en listado y monitor

  Scenario: Edición de URL stream
    Given una cámara existente
    When se actualiza la URL de stream con valor válido
    Then el cambio persiste
    And el monitor usa la URL actualizada
```

### US-010 - Mostrar error detallado de edición de cámara
Como operador de panel
quiero ver el código y detalle real del error
para diagnosticar rápido (ej: entitlement).

Criterios (Gherkin):
```gherkin
Feature: Errores accionables en UI

  Scenario: Error 4xx/5xx en edición de cámara
    Given un usuario autenticado con permisos de edición
    When guarda una edición que falla por regla de negocio
    Then la UI muestra código de error y mensaje
    And si existe, también muestra details del backend
```

### US-011 - Estado health de stream confiable
Como operador
quiero ver health real del stream
para detectar offline/degradado sin falsos negativos.

Criterios (Gherkin):
```gherkin
Feature: Health check de stream

  Scenario: Health endpoint accesible y stream activo
    Given una cámara con feed operativo
    When el monitor consulta health
    Then muestra estado online o degraded según latencia/error-rate

  Scenario: Health endpoint no accesible
    Given un problema de conectividad o CORS hacia health
    When el monitor consulta health
    Then muestra estado unknown
    And expone diagnóstico técnico legible
```

## Epic D - App Cliente

### US-012 - Login customer
Como `customer`
quiero iniciar sesión en la app
para acceder a mis domicilios y cámaras.

Criterios (Gherkin):
```gherkin
Feature: Login customer

  Scenario: Customer autenticado
    Given un customer activo
    When inicia sesión con credenciales válidas
    Then accede al inicio de la app

  Scenario: Customer con múltiples tenants
    Given un customer asociado a más de un tenant
    When inicia sesión
    Then puede elegir el tenant activo
```

### US-013 - Alta de domicilio
Como `customer`
quiero registrar uno o más domicilios
para organizar cámaras y miembros por ubicación.

Criterios (Gherkin):
```gherkin
Feature: Domicilios

  Scenario: Crear domicilio
    Given un customer autenticado
    When crea un domicilio con nombre y dirección
    Then el domicilio queda disponible para asociar cámaras y miembros
```

### US-014 - Alta de miembros de familia/empleados
Como `customer`
quiero agregar miembros por domicilio
para definir quién recibe alertas y qué puede ver.

Criterios (Gherkin):
```gherkin
Feature: Miembros por domicilio

  Scenario: Crear miembro con permisos
    Given un customer autenticado
    And un domicilio existente
    When agrega un miembro con tipo familiar o empleado y permisos
    Then el miembro queda asociado al domicilio
```

### US-015 - Alta de cámara en app cliente
Como `customer`
quiero agregar una cámara con URL RTSP
para monitorear mi domicilio.

Criterios (Gherkin):
```gherkin
Feature: Alta de cámara por customer

  Scenario: Alta y validación exitosa
    Given un customer autenticado
    And un domicilio existente
    When registra una cámara con URL RTSP válida
    Then la cámara queda asociada al domicilio
    And se ejecuta validación de conectividad inicial

  Scenario: URL inválida
    Given un customer autenticado
    When registra una cámara con URL inválida
    Then el sistema rechaza la operación con mensaje de validación
```

### US-016 - Ver monitor en tiempo real
Como `customer` u `operator`
quiero ver el feed en tiempo real
para monitorear eventos actuales.

Criterios (Gherkin):
```gherkin
Feature: Monitor realtime

  Scenario: Visualización de feed
    Given una cámara online y autorizada para el usuario
    When abre la pantalla de monitor
    Then el reproductor muestra frames actuales
    And el usuario puede refrescar feeds manualmente
```

### US-017 - Recibir notificaciones en tiempo real
Como `customer` u `operator`
quiero recibir alertas en tiempo real
para actuar ante incidentes.

Criterios (Gherkin):
```gherkin
Feature: Notificaciones realtime

  Scenario: Notificación por evento detectado
    Given una regla activa para una cámara
    When se detecta un evento que cumple condición
    Then se crea una notificación
    And se entrega por el canal configurado en tiempo real
```

### US-018 - Solicitar suscripción
Como `customer`
quiero solicitar una suscripción o cambio de plan
para activar servicios.

Criterios (Gherkin):
```gherkin
Feature: Solicitud de suscripción

  Scenario: Solicitud creada
    Given un customer autenticado
    When selecciona un plan y confirma solicitud
    Then se crea un registro pending_review
    And un admin puede revisarlo en panel
```

### US-019 - Cargar comprobante de depósito
Como `customer`
quiero subir imagen del comprobante
para acreditar el pago de mi suscripción.

Criterios (Gherkin):
```gherkin
Feature: Comprobante de depósito

  Scenario: Carga de imagen exitosa
    Given un customer autenticado con una solicitud pendiente
    When carga una imagen válida y completa monto/fecha/referencia
    Then el comprobante queda asociado a la solicitud
    And el estado permanece pending_review hasta validación
```

## 3. Reglas transversales (Definition of Ready/Test)
- Cada historia debe identificar actor, tenant-context y permiso esperado.
- Errores deben exponer `code`, `message`, `details` cuando existan.
- Toda acción sensible queda auditada (`actor`, `tenant`, `resource`, `timestamp`).
- Cobertura mínima:
  - API integration tests por rol.
  - E2E panel para flujos administrativos críticos.
  - E2E app para login + cámara + notificaciones + suscripción.

## 4. Propuesta de implementación por olas
1. Ola 1 (P0): US-001 a US-006, US-008, US-009, US-010.
2. Ola 2 (P1): US-007, US-011, US-012 a US-016.
3. Ola 3 (P1/P2): US-017, US-018, US-019.

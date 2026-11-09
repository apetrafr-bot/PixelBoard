# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People collecting ideas, reference images, and notes for visual projects, especially pixel-art work. The initial audience and use cases are inferred from the MVP brief.

## Product Purpose

PixelBoard is a visual workspace for arranging ideas, pixel-art references, nested boards, and lightweight team tasks, with local-only operation and an optional shared PHP/MySQL team mode.

## Positioning

A lightweight visual board that treats pixel-art images as first-class material: it preserves source resolution and uses pixelated rendering when images are enlarged. This positioning is inferred from the MVP brief.

## Operating Context

Users build a board in a web browser, arrange note and image cards, and return either to local browser data or, when configured, a shared server workspace. French is the default interface language.

## Capabilities and Constraints

- Local workspace: an effectively unbounded, pannable board with movable notes, images, links, tasks, connectors, drawings, nested boards, browser persistence, and JSON export.
- Local mode: color- and tag-labeled member profiles, task assignment and status, and per-member task lists are stored only in IndexedDB.
- Optional shared mode: PHP 8.1+ and PDO MySQL API with invitation-only member registration, session authentication, workspace-scoped boards and profiles, owner-managed tags/colors, and version-checked board writes. Host configuration and database credentials must be supplied by the site owner; there is no server-side setup secret or database credential in the repository.
- Keep implementation lightweight and provide local run instructions in README.
- The shared mode is not active until the PHP API and MySQL database are configured on the host. Existing local data is never uploaded automatically; the owner explicitly imports it.
- Milanote import must use an officially documented public integration only. If none is documented and available, show an honest unavailable state; never simulate a successful import or request Milanote credentials.
- Any inferred details beyond these requirements remain open.

## Brand Commitments

The product name is PixelBoard. French is the default UI language. No existing logo, visual identity, or Milanote branding is authorized.

## Evidence on Hand

The MVP requirements are the only product evidence. Do not invent customer claims, usage statistics, or an available Milanote integration.

## Product Principles

- Make visual material easy to place and rearrange.
- Preserve pixel-art sharpness instead of smoothing it during display.
- Be explicit about where board data is stored and which integrations are unavailable.

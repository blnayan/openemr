# Archived: Synthea demo seeder

These files implemented the Synthea CSV-pack seeder. The active demo data
flow uses `contrib/agentforge/seed_demo_pdf_patients.php` instead, which
seeds the four real-document patients that own the fixtures under
`agent/data/fixtures/`.

Kept for possible future use (rich multi-decade encounter / condition /
medication / lab histories from Synthea). To restore:

1. Move `seed_demo_data.php` back to `contrib/agentforge/`.
2. Move `lib/synthea_download.php` back to `contrib/agentforge/lib/`.
3. Move `data/` back to `contrib/agentforge/data/`.
4. Re-add the `OE_DEMO_SEED` block to `auto_configure.php` and the seed
   half of `interface/agentforge/admin/refresh.php` (see git history for
   the exact code that was removed).

Shared classes — `lib/SyntheaLoader.php`, `lib/AppointmentScheduler.php`,
`lib/DemoDataSeeder.php` — were intentionally left in `contrib/agentforge/lib/`
because the PDF seeder reuses `DemoDataSeeder::reset()` for the FK-safe
`AGENTFORGE-*` patient cascade.

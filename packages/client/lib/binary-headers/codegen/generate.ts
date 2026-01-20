import { writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateFromSchema } from './generator';
import type { ProtocolSchema } from './schema';

function printUsage(): void {
  console.log('Usage: npx tsx generate.ts <schema-file>');
  console.log('');
  console.log('Examples:');
  console.log('  npx tsx generate.ts ../schemas/v1.ts');
  console.log('  npx tsx generate.ts ./my-custom-schema.ts');
  console.log('');
  console.log('The schema file must export a ProtocolSchema object.');
}

async function loadSchema(schemaPath: string): Promise<ProtocolSchema> {
  const absolutePath = resolve(process.cwd(), schemaPath);
  const fileUrl = pathToFileURL(absolutePath).href;

  try {
    const module = await import(fileUrl);

    // Find the first exported ProtocolSchema (check top-level and default)
    const candidates = [
      ...Object.values(module),
      ...Object.values(module.default ?? {}),
    ];

    for (const value of candidates) {
      if (value && typeof value === 'object' && 'name' in value && 'version' in value && 'messages' in value) {
        return value as ProtocolSchema;
      }
    }

    console.error(`No ProtocolSchema export found in: ${schemaPath}`);
    process.exit(1);
  } catch (err) {
    console.error(`Failed to load schema from: ${schemaPath}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const schemaPath = args[0];
  const schema = await loadSchema(schemaPath);
  const output = generateFromSchema(schema);

  // Output to ../generated/ folder (sibling to codegen/)
  const outputDir = join(dirname(__dirname), 'generated');

  const files = [
    ['constants.ts', output.constants],
    ['types.ts', output.types],
    ['encoder.ts', output.encoder],
    ['decoder.ts', output.decoder],
  ] as const;

  for (const [filename, content] of files) {
    writeFileSync(join(outputDir, filename), content);
  }

  console.log(`Generated from ${schema.name} protocol v${schema.version} (${basename(schemaPath)}):`);
  files.forEach(([f]) => console.log(`  - generated/${f}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

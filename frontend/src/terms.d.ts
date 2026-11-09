// `$terms` (registered in main.ts): the signed-in department's own words, in every template.
import type { DepartmentTerms } from '@sh/shared';

declare module 'vue' {
  interface ComponentCustomProperties {
    $terms: DepartmentTerms;
  }
}
export {};

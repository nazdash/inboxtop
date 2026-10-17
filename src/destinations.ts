import { z } from 'zod';
export const DestinationSchema = z.enum([
  'inbox',
  'act',
  'read',
  'clear',
  'check',
  'subscriptions',
  'chat',
  'settings',
]);
export type Destination = z.infer<typeof DestinationSchema>;

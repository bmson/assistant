import { estimatedCostHandler } from '@/lib/estimated-cost-http-runtime';

export const GET = (request: Request) => estimatedCostHandler(request, 'overview', false);

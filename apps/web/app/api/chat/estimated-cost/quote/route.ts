import { estimatedCostHandler } from '@/lib/estimated-cost-http-runtime';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => estimatedCostHandler(request, 'quote', false);
export const POST = (request: Request) => estimatedCostHandler(request, 'quote', false);

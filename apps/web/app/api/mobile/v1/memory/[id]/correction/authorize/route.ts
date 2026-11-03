import { handleMobileOwnerMemoryCorrectionRequest } from '@/lib/mobile-owner-memory-correction-runtime';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleMobileOwnerMemoryCorrectionRequest(request, 'authorize', { memoryId: id });
}

import { handleOwnerEditorRequest } from '@/lib/owner-editor-runtime';

export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  return handleOwnerEditorRequest(request, '/api/profile/knowledge/memory');
}
export async function POST(request: Request): Promise<Response> {
  return handleOwnerEditorRequest(request, '/api/profile/knowledge/memory');
}

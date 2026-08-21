import { auth } from "@/auth";
import { getTradeAnalytics, getAnalyticsByTradeClass } from "@/lib/server/trade-journal-service";

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const byClass = url.searchParams.get("byClass") === "true";

    if (byClass) {
      const analytics = await getAnalyticsByTradeClass(session.user.id);
      return Response.json(analytics);
    }

    const analytics = await getTradeAnalytics(session.user.id);
    return Response.json(analytics);
  } catch (error) {
    console.error("Error fetching analytics:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

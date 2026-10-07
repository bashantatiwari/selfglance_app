from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import Session, ActivityLog
from .serializers import SessionSerializer, ActivityLogSerializer

class SessionViewSet(viewsets.ModelViewSet):
    queryset = Session.objects.all().order_by('-start_time')
    serializer_class = SessionSerializer

    @action(detail=False, methods=['get'])
    def active(self, request):
        """Get the currently active session."""
        active_session = Session.objects.filter(is_active=True).first()
        if active_session:
            serializer = self.get_serializer(active_session)
            return Response(serializer.data)
        return Response(None)

class ActivityLogViewSet(viewsets.ModelViewSet):
    queryset = ActivityLog.objects.all().order_by('-timestamp')
    serializer_class = ActivityLogSerializer

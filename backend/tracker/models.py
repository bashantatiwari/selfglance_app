from django.db import models

class Session(models.Model):
    goal = models.CharField(max_length=255)
    start_time = models.DateTimeField(auto_now_add=True)
    end_time = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f"{self.goal} ({self.start_time})"

class ActivityLog(models.Model):
    session = models.ForeignKey(Session, related_name='logs', on_delete=models.CASCADE)
    timestamp = models.DateTimeField(auto_now_add=True)
    screenshot_path = models.CharField(max_length=500, blank=True, null=True)
    ocr_text = models.TextField(blank=True, null=True)
    llm_summary = models.TextField(blank=True, null=True)
    is_productive = models.BooleanField(default=True)
    
    def __str__(self):
        return f"Log {self.id} - {self.timestamp}"

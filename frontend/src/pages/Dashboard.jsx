import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const SESSION_API = 'http://127.0.0.1:8000/api/v1/sessions/';
const LOGS_API = 'http://127.0.0.1:8000/api/v1/logs/';

function Dashboard() {
  const [session, setSession] = useState(null);
  const [logs, setLogs] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    fetchSession();
    const interval = setInterval(() => {
        fetchLogs();
    }, 5000);
    return () => clearInterval(interval);
  }, [session]);

  const fetchSession = async () => {
    try {
      const res = await axios.get(`${SESSION_API}active/`);
      if (res.data) {
          setSession(res.data);
          fetchLogs();
      } else {
          navigate('/');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchLogs = async () => {
      try {
          const res = await axios.get(LOGS_API);
          setLogs(res.data);
      } catch (e) { console.error(e); }
  }

  const stopSession = async () => {
    if (!session) return;
    await axios.patch(`${SESSION_API}${session.id}/`, { is_active: false });
    navigate('/');
  };

  return (
    <div className="dashboard">
      {session && (
        <div className="status-bar">
           <h2>Focusing on: <span className="highlight">{session.goal}</span></h2>
           <button onClick={stopSession} className="stop-btn">Stop Session</button>
        </div>
      )}

      <div className="logs-list">
        <h3>Activity Timeline</h3>
        {logs.map(log => (
            <div key={log.id} className={`log-item ${log.is_productive ? 'productive' : 'distracted'}`}>
                <span className="time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span className="status">{log.is_productive ? '✅ Focused' : '❌ Distracted'}</span>
                <p className="summary">{log.llm_summary}</p>
            </div>
        ))}
      </div>
    </div>
  );
}

export default Dashboard;

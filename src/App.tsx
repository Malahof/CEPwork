import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { EditorPage } from './components/EditorPage';
import { useDocStore } from './store/useDocStore';
import './App.css';

function App() {
  const loadDocs = useDocStore((state) => state.loadDocs);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  return (
    <div className="app">
      <Sidebar />
      <EditorPage />
    </div>
  );
}

export default App;

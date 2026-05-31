import { Sidebar } from './components/Sidebar';
import { EditorPage } from './components/EditorPage';
import './App.css';

function App() {
  return (
    <div className="app">
      <Sidebar />
      <EditorPage />
    </div>
  );
}

export default App;

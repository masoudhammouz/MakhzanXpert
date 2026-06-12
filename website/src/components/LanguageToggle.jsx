import { useLanguage } from '../context/LanguageContext.jsx';

export default function LanguageToggle() {
  const { language, setLanguage } = useLanguage();

  return (
    <div className="language-toggle">
      <button
        type="button"
        className={language === 'en' ? 'language-option active' : 'language-option'}
        onClick={() => setLanguage('en')}
      >
        EN
      </button>
      <button
        type="button"
        className={language === 'ar' ? 'language-option active' : 'language-option'}
        onClick={() => setLanguage('ar')}
      >
        AR
      </button>
    </div>
  );
}

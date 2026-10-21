using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;

namespace MedLink.App;

public abstract class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Raise(name);
        return true;
    }

    protected void Raise([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    /// <summary>Raises a change for every property (used when the language changes).</summary>
    protected void RaiseAll() => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(string.Empty));
}

public sealed class Command(Action<object?> run, Func<object?, bool>? can = null) : ICommand
{
    public Command(Action run, Func<bool>? can = null) : this(_ => run(), can is null ? null : _ => can()) { }
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => can?.Invoke(parameter) ?? true;
    public void Execute(object? parameter) { if (CanExecute(parameter)) run(parameter); }
    public void Refresh() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}

/// <summary>Runs work on the UI thread. Tests run it inline.</summary>
public interface IUi
{
    void Post(Action a);
}

public sealed class InlineUi : IUi
{
    public void Post(Action a) => a();
}

/// <summary>Opens links in the browser (WhatsApp). The WPF app uses the shell; tests record the link.</summary>
public interface ILauncher
{
    void Open(string url);
}

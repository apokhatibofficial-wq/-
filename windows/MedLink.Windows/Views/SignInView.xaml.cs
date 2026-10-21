using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using MedLink.App;

namespace MedLink.Windows.Views;

/// <summary>PasswordBox is not bindable (by design, so the password never sits in a binding); it is copied to the view model on change.</summary>
public partial class SignInView : UserControl
{
    private readonly SignInViewModel _vm;
    private bool _syncing;

    public SignInView(SignInViewModel vm)
    {
        InitializeComponent();
        DataContext = _vm = vm;
        vm.PropertyChanged += OnVm;
        Loaded += (_, _) => { if (vm.Email.Length == 0) EmailBox.Focus(); else PasswordBox.Focus(); };
    }

    private void OnVm(object? sender, PropertyChangedEventArgs e)
    {
        // The view model clears the password after sign-in or on reset.
        if (e.PropertyName == nameof(SignInViewModel.Password) && _vm.Password.Length == 0 && !_syncing)
        {
            PasswordBox.Clear();
            PasswordText.Clear();
        }
        if (e.PropertyName == nameof(SignInViewModel.NeedTotp) && _vm.NeedTotp) Dispatcher.BeginInvoke(() => TotpBox.Focus());
    }

    private void OnPasswordChanged(object sender, RoutedEventArgs e)
    {
        if (_syncing) return;
        _syncing = true;
        _vm.Password = PasswordBox.Password;
        PasswordText.Text = PasswordBox.Password;
        _syncing = false;
    }

    private void OnPasswordTextChanged(object sender, TextChangedEventArgs e)
    {
        if (_syncing) return;
        _syncing = true;
        _vm.Password = PasswordText.Text;
        PasswordBox.Password = PasswordText.Text;
        _syncing = false;
    }

    private void OnToggleShow(object sender, RoutedEventArgs e)
    {

        // Click runs before the command flips ShowPassword, so this is the state about to be set.
        var show = !_vm.ShowPassword;
        PasswordText.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        PasswordBox.Visibility = show ? Visibility.Collapsed : Visibility.Visible;
        (show ? (Control)PasswordText : PasswordBox).Focus();
    }

    private void OnKey(object sender, RoutedEventArgs e) =>
        CapsHint.Visibility = Keyboard.IsKeyToggled(Key.CapsLock) ? Visibility.Visible : Visibility.Collapsed;
}

package orders

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Mailer sends the order confirmation.
type Mailer interface {
	Confirm(ctx context.Context, email string, order int64) error
}

// HTTPMailer posts to the mail service's API with the key from MAIL_KEY.
type HTTPMailer struct {
	Endpoint string
}

func (m HTTPMailer) Confirm(ctx context.Context, email string, order int64) error {
	form := url.Values{"to": {email}, "subject": {fmt.Sprintf("Order %d", order)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("MAIL_KEY"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		return fmt.Errorf("mail service: %s", res.Status)
	}
	return nil
}
